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

        const beforeRes = await client.query(
            `SELECT COUNT(*)::int AS cnt
             FROM transactions t
             JOIN salary_adjustments sa ON sa.id = t.salary_adjustment_id
             WHERE t.source_module = 'salary'
               AND COALESCE(t.is_deleted, false) = false
               AND COALESCE(sa.is_deleted, false) = false
               AND COALESCE(sa.cash_posting_mode, 'none') = 'none'
               AND t.account_id IS NOT NULL`
        );
        const affectedBefore = beforeRes.rows[0].cnt;

        const fixRes = await client.query(
            `UPDATE transactions t
             SET account_id = NULL
             FROM salary_adjustments sa
             WHERE sa.id = t.salary_adjustment_id
               AND t.source_module = 'salary'
               AND COALESCE(t.is_deleted, false) = false
               AND COALESCE(sa.is_deleted, false) = false
               AND COALESCE(sa.cash_posting_mode, 'none') = 'none'
               AND t.account_id IS NOT NULL`
        );

        const touchedAccountsRes = await client.query(
            `SELECT ARRAY_AGG(DISTINCT id)::int[] AS ids
             FROM accounts`
        );
        const accountIds = touchedAccountsRes.rows[0].ids || [];

        if (accountIds.length > 0) {
            await client.query(
                `UPDATE accounts a
                 SET balance = ROUND(COALESCE((
                     SELECT SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END) -
                            SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END)
                     FROM transactions t
                     WHERE t.account_id = a.id
                       AND COALESCE(t.is_deleted, false) = false
                 ), 0), 2)
                 WHERE a.id = ANY($1::int[])`,
                [accountIds]
            );
        }

        const afterRes = await client.query(
            `SELECT COUNT(*)::int AS cnt
             FROM transactions t
             JOIN salary_adjustments sa ON sa.id = t.salary_adjustment_id
             WHERE t.source_module = 'salary'
               AND COALESCE(t.is_deleted, false) = false
               AND COALESCE(sa.is_deleted, false) = false
               AND COALESCE(sa.cash_posting_mode, 'none') = 'none'
               AND t.account_id IS NOT NULL`
        );
        const affectedAfter = afterRes.rows[0].cnt;

        await client.query('COMMIT');
        console.log(JSON.stringify({
            success: true,
            virtualSalaryTxWithRealAccount_before: affectedBefore,
            rowsUpdated: fixRes.rowCount,
            virtualSalaryTxWithRealAccount_after: affectedAfter,
            accountsRecalculated: accountIds.length
        }, null, 2));
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Data-fix failed:', e.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();
