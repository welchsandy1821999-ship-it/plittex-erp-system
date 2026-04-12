require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function run() {
    try {
        const res1 = await pool.query("SELECT id FROM production_batches WHERE batch_number = 'П-20260319-4746'");
        if (res1.rows.length === 0) { console.log('not found'); return; }
        const batchId = res1.rows[0].id;
        const res2 = await pool.query(
            "SELECT id, warehouse_id, movement_type, quantity, description, to_char(movement_date, 'YYYY-MM-DD HH24:MI') as date FROM inventory_movements WHERE batch_id = $1 ORDER BY movement_date ASC",
            [batchId]
        );
        console.table(res2.rows);
    } catch(e) {
        console.error(e);
    } finally {
        pool.end();
        process.exit(0);
    }
}
run();
