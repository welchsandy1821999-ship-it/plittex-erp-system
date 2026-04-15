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
        console.log("Applying patch to fix the item_id to 429...");
        await pool.query(`
            UPDATE inventory_movements 
            SET item_id = 429,
                description = 'Закупка продукции от Швецова А.В. (ТМЦ: 43942.50) · Партия: #П-20260323-2124'
            WHERE id = 1196
        `);

        // Also update the description slightly.
        const updated = await pool.query(`SELECT * FROM inventory_movements WHERE id = 1196`);
        console.log("Fixed record:");
        console.log(updated.rows[0]);

        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}
run();
