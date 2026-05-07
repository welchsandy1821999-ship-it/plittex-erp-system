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

        const orphanRes = await client.query(
            `SELECT t.id AS tx_id, t.salary_adjustment_id
             FROM transactions t
             LEFT JOIN client_orders co ON co.id = t.linked_order_id
             WHERE t.linked_order_id IS NOT NULL
               AND co.id IS NULL
               AND t.transaction_type = 'expense'
               AND COALESCE(t.is_deleted, false) = false
               AND (
                   t.salary_adjustment_id IS NOT NULL
                   OR EXISTS (
                       SELECT 1 FROM salary_adjustments sa
                       WHERE sa.linked_transaction_id = t.id
                         AND COALESCE(sa.is_deleted, false) = false
                   )
               )`
        );

        const txIds = orphanRes.rows.map((r) => Number(r.tx_id)).filter((v) => Number.isInteger(v) && v > 0);
        const adjIdsFromTx = orphanRes.rows.map((r) => Number(r.salary_adjustment_id)).filter((v) => Number.isInteger(v) && v > 0);

        const adjByLinkedRes = txIds.length
            ? await client.query(
                `SELECT id
                 FROM salary_adjustments
                 WHERE linked_transaction_id = ANY($1::int[])
                   AND COALESCE(is_deleted, false) = false`,
                [txIds]
            )
            : { rows: [] };
        const adjIdsByLinked = adjByLinkedRes.rows.map((r) => Number(r.id)).filter((v) => Number.isInteger(v) && v > 0);
        const adjIds = Array.from(new Set([...adjIdsFromTx, ...adjIdsByLinked]));

        let salaryAdjustmentsSoftDeleted = 0;
        if (adjIds.length > 0) {
            const updAdj = await client.query(
                `UPDATE salary_adjustments
                 SET is_deleted = true
                 WHERE id = ANY($1::int[])
                   AND COALESCE(is_deleted, false) = false`,
                [adjIds]
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
        }

        await client.query('COMMIT');
        console.log(JSON.stringify({
            success: true,
            orphanBridgeTransactionsFound: txIds.length,
            transactionsSoftDeleted,
            salaryAdjustmentsSoftDeleted
        }, null, 2));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Orphan bridge cleanup failed:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();
