const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:Plittex_2026_SQL@localhost:5432/plittex_erp' });

async function run() {
    try {
        const result = await pool.query(`
            SELECT DISTINCT m.item_id, i.name 
            FROM inventory_movements m
            JOIN items i ON m.item_id = i.id
            WHERE m.warehouse_id = 5 
              AND i.name NOT ILIKE '%2 сорт%' 
              AND i.name NOT ILIKE '%2-й сорт%'
        `);
        console.log("Found items to migrate on warehouse 5:");
        console.table(result.rows);
    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}
run();
