#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
    const pool = new Pool({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: Number(process.env.DB_PORT || 5432)
    });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const tailsRes = await client.query(
            `SELECT sa.id AS adjustment_id,
                    sa.linked_transaction_id AS tx_id
             FROM salary_adjustments sa
             WHERE COALESCE(sa.is_deleted, false) = false
               AND COALESCE(sa.source_module, '') = 'sales'
               AND COALESCE(sa.operation_kind, '') = 'order_offset'`
        );

        const adjustmentIds = tailsRes.rows.map((r) => Number(r.adjustment_id)).filter((v) => Number.isInteger(v) && v > 0);
        const txIdsFromAdj = tailsRes.rows.map((r) => Number(r.tx_id)).filter((v) => Number.isInteger(v) && v > 0);

        const txByAdjRes = adjustmentIds.length
            ? await client.query(
                `SELECT id, account_id
                 FROM transactions
                 WHERE salary_adjustment_id = ANY($1::int[])
                   AND COALESCE(is_deleted, false) = false`,
                [adjustmentIds]
            )
            : { rows: [] };
        const txIdsByAdj = txByAdjRes.rows.map((r) => Number(r.id)).filter((v) => Number.isInteger(v) && v > 0);
        const accountIds = txByAdjRes.rows.map((r) => Number(r.account_id)).filter((v) => Number.isInteger(v) && v > 0);
        const txIds = Array.from(new Set([...txIdsFromAdj, ...txIdsByAdj]));

        let salaryAdjustmentsSoftDeleted = 0;
        if (adjustmentIds.length > 0) {
            const updAdj = await client.query(
                `UPDATE salary_adjustments
                 SET is_deleted = true
                 WHERE id = ANY($1::int[])
                   AND COALESCE(is_deleted, false) = false`,
                [adjustmentIds]
            );
            salaryAdjustmentsSoftDeleted = updAdj.rowCount;
        }

        let transactionsSoftDeleted = 0;
        if (txIds.length > 0) {
            const updTx = await client.query(
                `UPDATE transactions
                 SET is_deleted = true
                 WHERE id = ANY($1::int[])
                   AND COALESCE(is_deleted, false) = false`,
                [txIds]
            );
            transactionsSoftDeleted = updTx.rowCount;

            await client.query(
                `UPDATE salary_payments
                 SET is_deleted = true
                 WHERE linked_transaction_id = ANY($1::int[])
                   AND COALESCE(is_deleted, false) = false`,
                [txIds]
            );
        }

        const uniqueAccounts = Array.from(new Set(accountIds));
        if (uniqueAccounts.length > 0) {
            await client.query(
                `UPDATE accounts a
                 SET balance = ROUND(COALESCE((
                     SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) -
                            SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END)
                     FROM transactions t
                     WHERE t.account_id = a.id
                       AND COALESCE(t.is_deleted, false) = false
                 ), 0), 2)
                 WHERE a.id = ANY($1::int[])`,
                [uniqueAccounts]
            );
        }

        await client.query('COMMIT');
        console.log(JSON.stringify({
            success: true,
            salaryAdjustmentsSoftDeleted,
            transactionsSoftDeleted,
            accountsRecalculated: uniqueAccounts.length
        }, null, 2));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Sales order-offset tail cleanup failed:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();
