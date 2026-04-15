const { Pool } = require('pg');
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'plittex',
    password: 'admin',
    port: 5432,
});

async function run() {
    try {
        console.log("Searching for the record...");
        const res = await pool.query(`
            SELECT * FROM inventory_movements 
            WHERE DATE(movement_date) = '2026-04-13'
            AND quantity = 189
        `);
        console.log("Movement records:");
        console.log(res.rows);

        const supplierRes = await pool.query(`
            SELECT id, name FROM counterparties WHERE name ILIKE '%Швецов%'
        `);
        console.log("Suppliers:");
        console.log(supplierRes.rows);

        const itemRes = await pool.query(`
            SELECT id, name, item_type FROM items WHERE name ILIKE '%Поребрик газонный 1000х200х80 Гладкий Серый%'
        `);
        console.log("Item:");
        console.log(itemRes.rows);

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();
