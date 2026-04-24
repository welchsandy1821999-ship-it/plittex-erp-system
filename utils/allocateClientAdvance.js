/**
 * Автораспределение «простого» аванса от покупателя по заказам (FIFO: created_at, id).
 * Очередь — client_orders.pending_debt (контрактный остаток, согласован с дашбордом «ожидаемые поступления»).
 * Не касается: оплаты по отдельному счёту, взаимозачёты, тех. проводок, переводов, подотчёта.
 * Одна исходная проводка может разбиваться: части с linked_order_id, хвост без связи = свободный аванс.
 */
const logger = require('./logger');

const EXCLUDE_CATEGORIES = new Set([
    'Оплата по счету',
    'Техническая проводка',
    'Ввод начальных остатков',
    'Корректировка',
    'Взаимозачет',
    'Взаимозачет аванса',
    'Перевод',
    'Перемещение',
    'Возврат из подотчета'
]);

/**
 * @param {import('pg').PoolClient} client
 * @param {import('pg').QueryResult['rows'][0]} row — строка transactions (с id)
 * @returns {{ applied: number, orders: { id: number, doc: string, part: number }[], remainder: number }}
 */
async function allocateUnlinkedClientIncome(client, row) {
    const out = { applied: 0, orders: [], remainder: 0 };
    if (!row || row.transaction_type !== 'income' || !row.counterparty_id) return out;
    if (row.is_deleted) return out;
    if (row.linked_order_id) return out;
    if (row.category && EXCLUDE_CATEGORIES.has(String(row.category).trim())) return out;

    let total = Math.max(0, parseFloat(row.amount) || 0);
    if (total <= 0) return out;

    const oRes = await client.query(
        `
        SELECT id, doc_number, pending_debt
        FROM client_orders
        WHERE counterparty_id = $1
          AND status != 'cancelled'
          AND COALESCE(pending_debt, 0)::numeric > 0
        ORDER BY created_at ASC, id ASC
        FOR UPDATE
    `,
        [row.counterparty_id]
    );
    if (oRes.rows.length === 0) {
        out.remainder = total;
        return out;
    }

    let moneyLeft = total;
    const chunks = [];
    for (const o of oRes.rows) {
        if (moneyLeft <= 0) break;
        const need = Math.max(0, parseFloat(o.pending_debt) || 0);
        if (need <= 0) continue;
        const part = Math.min(moneyLeft, need);
        if (part <= 0) continue;

        await client.query(
            `
            UPDATE client_orders SET
                paid_amount = COALESCE(paid_amount, 0) + $1,
                pending_debt = GREATEST(0, COALESCE(pending_debt, 0) - $1)
            WHERE id = $2
        `,
            [part, o.id]
        );
        chunks.push({ orderId: o.id, docNumber: o.doc_number, part });
        moneyLeft -= part;
        out.applied += part;
        out.orders.push({ id: o.id, doc: o.doc_number, part });
    }

    if (chunks.length === 0) {
        out.remainder = total;
        return out;
    }

    const baseDesc = String(row.description || '').trim() || 'Поступление от покупателя';
    const [head, ...tail] = chunks;

    const desc1 = baseDesc.includes(String(head.docNumber)) ? baseDesc : `${baseDesc} / Заказ ${head.docNumber}`;
    await client.query(
        `
        UPDATE transactions SET
            amount = $1,
            linked_order_id = $2,
            description = $3
        WHERE id = $4
    `,
        [head.part, head.orderId, desc1, row.id]
    );

    for (const c of tail) {
        const descC = `${baseDesc} / часть, заказ ${c.docNumber}`;
        await client.query(
            `
            INSERT INTO transactions (
                amount, transaction_type, category, description, vat_amount,
                payment_method, account_id, counterparty_id, transaction_date, cost_group_override, linked_order_id
            ) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, $10)
        `,
            [
                c.part,
                row.transaction_type,
                row.category,
                descC,
                row.payment_method,
                row.account_id,
                row.counterparty_id,
                row.transaction_date,
                row.cost_group_override || null,
                c.orderId
            ]
        );
    }

    if (moneyLeft > 0.001) {
        const descR = `${baseDesc} / аванс (сверх заказов)`;
        await client.query(
            `
            INSERT INTO transactions (
                amount, transaction_type, category, description, vat_amount,
                payment_method, account_id, counterparty_id, transaction_date, cost_group_override, linked_order_id
            ) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, NULL)
        `,
            [
                moneyLeft,
                row.transaction_type,
                row.category,
                descR,
                row.payment_method,
                row.account_id,
                row.counterparty_id,
                row.transaction_date,
                row.cost_group_override || null
            ]
        );
    }
    out.remainder = moneyLeft > 0.001 ? moneyLeft : 0;
    logger.info(
        `allocateUnlinkedClientIncome: tx#${row.id} cp#${row.counterparty_id} → ${chunks.length} чел(ов), остаток ${(moneyLeft > 0.001 && moneyLeft) || 0}`
    );
    return out;
}

module.exports = { allocateUnlinkedClientIncome, EXCLUDE_CATEGORIES };
