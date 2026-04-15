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
        const cp = await pool.query(`SELECT id FROM counterparties WHERE name ILIKE '%Швецов%' LIMIT 1`);
        if(cp.rows.length === 0){
            console.log("No Shvetsov found.");
            return process.exit(0);
        }
        const cid = cp.rows[0].id;
        
        console.log("Orders:");
        const orders = await pool.query(`SELECT id, doc_number, status, total_amount, paid_amount, created_at FROM client_orders WHERE counterparty_id = $1`, [cid]);
        console.table(orders.rows);

        console.log("\nTransactions:");
        const trans = await pool.query(`SELECT id, amount, transaction_type, category, description, transaction_date FROM transactions WHERE counterparty_id = $1`, [cid]);
        console.table(trans.rows);

        console.log("\nMovements (Purchases):");
        const movs = await pool.query(`SELECT id, amount, quantity, movement_type, description, movement_date FROM inventory_movements WHERE supplier_id = $1`, [cid]);
        console.table(movs.rows);

        process.exit(0);
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
}
run();
