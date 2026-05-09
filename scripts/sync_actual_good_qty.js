'use strict';
/**
 * Массовая синхронизация production_batches.actual_good_qty с фактом по движениям 1-го сорта:
 * - finished_receipt (quantity > 0)
 * - reserve_receipt только при первичном выпуске при распалубке (transaction_id IS NOT NULL);
 *   авто-ребаланс с WH «Готовая» в резерв (transaction_id NULL) исключается.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
});

(async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const upd = await client.query(`
            UPDATE production_batches pb
            SET actual_good_qty = COALESCE((
                SELECT SUM(
                    CASE
                        WHEN m.movement_type = 'finished_receipt'
                             AND m.quantity > 0
                        THEN m.quantity
                        WHEN m.movement_type = 'reserve_receipt'
                             AND m.transaction_id IS NOT NULL
                             AND m.quantity > 0
                        THEN m.quantity
                        ELSE 0
                    END
                )::numeric
                FROM inventory_movements m
                WHERE m.batch_id = pb.id
            ), 0)
        `);

        await client.query('COMMIT');
        console.log('[sync_actual_good_qty] UPDATE production_batches: rows affected =', upd.rowCount);

        const drift = await pool.query(`
            SELECT COUNT(*)::int AS cnt
            FROM production_batches pb
            WHERE ABS(
                COALESCE(pb.actual_good_qty, 0) - COALESCE((
                    SELECT SUM(
                        CASE
                            WHEN m.movement_type = 'finished_receipt'
                                 AND m.quantity > 0
                            THEN m.quantity
                            WHEN m.movement_type = 'reserve_receipt'
                                 AND m.transaction_id IS NOT NULL
                                 AND m.quantity > 0
                            THEN m.quantity
                            ELSE 0
                        END
                    )::numeric
                    FROM inventory_movements m
                    WHERE m.batch_id = pb.id
                ), 0)
            ) > 0.0001
        `);
        console.log('[sync_actual_good_qty] drift check (should be 0):', drift.rows[0].cnt);

        const extreme = await pool.query(`
            SELECT COUNT(*)::int AS cnt
            FROM production_batches
            WHERE planned_quantity IS NOT NULL
              AND planned_quantity > 0
              AND actual_good_qty > planned_quantity * 2
        `);
        console.log('[sync_actual_good_qty] batches with yield > 200% (review):', extreme.rows[0].cnt);

        const topExtreme = await pool.query(`
            SELECT batch_number, planned_quantity, actual_good_qty,
                   ROUND((actual_good_qty::numeric / NULLIF(planned_quantity, 0)) * 100, 1) AS yield_pct
            FROM production_batches
            WHERE planned_quantity > 0
              AND actual_good_qty > planned_quantity * 2
            ORDER BY (actual_good_qty::numeric / NULLIF(planned_quantity, 0)) DESC
            LIMIT 15
        `);
        if (topExtreme.rows.length) {
            console.log('[sync_actual_good_qty] sample yield > 200%:');
            console.table(topExtreme.rows);
        }
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[sync_actual_good_qty] ROLLBACK:', e.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
})();
