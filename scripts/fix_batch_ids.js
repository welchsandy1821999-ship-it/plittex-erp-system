const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'plittex_erp',
    password: 'Plittex_2026_SQL',
    port: 5432,
});

async function run() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Find all revisions with null batch
        const revs = await client.query(`SELECT id, item_id, quantity FROM inventory_movements WHERE movement_type = 'ревизия' AND batch_id IS NULL`);
        
        for (const row of revs.rows) {
            // Find the most recent batch_id for this item_id that has a positive finished_receipt
            const batchRes = await client.query(`
                SELECT batch_id 
                FROM inventory_movements 
                WHERE item_id = $1 
                AND batch_id IS NOT NULL 
                ORDER BY created_at DESC 
                LIMIT 1
            `, [row.item_id]);
            
            if (batchRes.rows.length > 0) {
                const batchId = batchRes.rows[0].batch_id;
                await client.query(`UPDATE inventory_movements SET batch_id = $1 WHERE id = $2`, [batchId, row.id]);
                console.log(`Updated movement ${row.id} (item ${row.item_id}) to batch_id = ${batchId} (Qty: ${row.quantity})`);
            } else {
                console.log(`No previous batch found for item ${row.item_id}. Leave as null.`);
            }
        }

        await client.query('COMMIT');
        console.log("Batches matched successfully.");
    } catch(e) {
        await client.query('ROLLBACK');
        console.error(e);
    } finally {
        client.release();
        pool.end();
    }
}
run();
