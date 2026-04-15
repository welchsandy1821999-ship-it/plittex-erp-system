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
        console.log("Searching for the record...");
        const moveRes = await pool.query(`
            SELECT * FROM inventory_movements 
            WHERE DATE(movement_date) = '2026-04-13'
            AND quantity = 189
            AND movement_type = 'adjustment'
        `);
        console.log("Found Movement Records:");
        console.log(moveRes.rows);

        if (moveRes.rows.length === 0) {
            // Also try searching by description if the exact date is missing timestamp precision
            const alternateRes = await pool.query(`
                SELECT * FROM inventory_movements 
                WHERE description LIKE '%факт 189, было 0%'
            `);
            console.log("Alternative found records:");
            console.log(alternateRes.rows);
            
            if (alternateRes.rows.length > 0) {
                moveRes.rows = alternateRes.rows;
            } else {
                console.log("No records found, exiting.");
                process.exit(1);
            }
        }

        const movId = moveRes.rows[0].id;

        const supplierRes = await pool.query(`
            SELECT id, name FROM counterparties WHERE name ILIKE '%Швецов Алексей%'
        `);
        console.log("Suppliers found:", supplierRes.rows);

        let supplierId = supplierRes.rows[0]?.id;
        if (!supplierId) {
            console.log("Supplier not found, creating 'Швецов Алексей Викторович'...");
            const insertSup = await pool.query(`
                INSERT INTO counterparties (name, type) 
                VALUES ('Швецов Алексей Викторович', 'supplier') RETURNING id
            `);
            supplierId = insertSup.rows[0].id;
        }

        const itemRes = await pool.query(`
            SELECT id, name FROM items WHERE name ILIKE '%Поребрик газонный 1000х200х80 Гладкий Серый%'
        `);
        console.log("Item found:", itemRes.rows);
        
        let itemId = itemRes.rows[0]?.id;
        if(!itemId) {
            console.log("Item 'Поребрик газонный 1000х200х80 Гладкий Серый' not found!!");
            process.exit(1);
        }

        // Apply Patch
        console.log("Applying patch to convert to purchase...");
        await pool.query(`
            UPDATE inventory_movements 
            SET 
                movement_type = 'purchase',
                supplier_id = $1,
                item_id = $2,
                amount = 43942.50,
                description = 'Закупка продукции (Оформлена задним числом из инвентаризации)',
                movement_date = '2026-04-13 00:00:00'
            WHERE id = $3
        `, [supplierId, itemId, movId]);

        // Also we need to check if there is a transaction associated. Usually adjustment doesn't have a transaction. Purchase can have one.
        // We will just leave it as an unpaid purchase unless instructed otherwise.
        console.log("Patch applied! Returning the updated record:");
        const updated = await pool.query(`SELECT * FROM inventory_movements WHERE id = $1`, [movId]);
        console.log(updated.rows[0]);

        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}
run();
