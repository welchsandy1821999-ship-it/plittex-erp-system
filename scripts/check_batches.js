require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

async function main() {
    const r = await pool.query(`
        SELECT b.id, b.batch_number, b.planned_quantity, b.mat_cost_total, b.status, b.production_date, p.name as product_name
        FROM production_batches b 
        JOIN items p ON b.product_id = p.id
        ORDER BY b.created_at DESC LIMIT 5
    `);
    console.log('=== Latest 5 production batches ===');
    r.rows.forEach(row => {
        console.log(`  [${row.id}] ${row.batch_number} | ${row.product_name} | qty=${row.planned_quantity} | mat_cost=${row.mat_cost_total} | status=${row.status} | date=${row.production_date}`);
    });
    await pool.end();
    process.exit(0);
}
main();
