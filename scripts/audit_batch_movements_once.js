'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const batchNumber = process.argv[2] || 'П-20260410-6059';

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
});

(async () => {
    const { rows } = await pool.query(
        `
        SELECT
            m.id,
            m.movement_date,
            m.movement_type,
            m.quantity,
            u.username AS created_by_username,
            m.user_id,
            m.transaction_id::text AS transaction_id,
            LEFT(m.description, 80) AS description_short
        FROM inventory_movements m
        JOIN production_batches pb ON pb.id = m.batch_id
        LEFT JOIN users u ON u.id = m.user_id
        WHERE pb.batch_number = $1
          AND m.movement_type IN ('finished_receipt', 'reserve_receipt')
          AND m.quantity > 0
        ORDER BY m.movement_date ASC NULLS LAST, m.id ASC
    `,
        [batchNumber]
    );

    console.table(
        rows.map((r) => ({
            id: r.id,
            movement_date: r.movement_date ? new Date(r.movement_date).toISOString() : null,
            movement_type: r.movement_type,
            quantity: String(r.quantity),
            created_by: r.created_by_username || (r.user_id != null ? `#${r.user_id}` : ''),
            transaction_id: r.transaction_id ? r.transaction_id.slice(0, 8) + '…' : '',
        }))
    );

    const byTx = {};
    for (const r of rows) {
        const k = r.transaction_id || 'NULL';
        byTx[k] = (byTx[k] || 0) + Number(r.quantity);
    }
    console.log('\n Sum qty by transaction_id (truncated id for display):');
    for (const [k, v] of Object.entries(byTx)) {
        console.log(`  ${k.slice(0, 12)}…  ->  ${v}`);
    }

    console.log('\nTOTAL positive grade1 qty:', rows.reduce((s, r) => s + Number(r.quantity), 0));

    await pool.end();
})().catch(async (e) => {
    console.error(e);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
