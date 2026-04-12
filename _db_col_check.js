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
        const res = await pool.query("SELECT * FROM inventory_movements WHERE movement_type = 'manual_transfer' LIMIT 5");
        console.table(res.rows);
    } catch(e) {
        console.error(e);
    } finally {
        pool.end();
        process.exit(0);
    }
}
run();
