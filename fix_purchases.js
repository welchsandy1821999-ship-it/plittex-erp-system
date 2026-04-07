const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:Plittex_2026_SQL@localhost:5432/plittex_erp' });

async function run() {
    try {
        await pool.query("UPDATE inventory_movements SET movement_type = 'purchase' WHERE movement_type = 'purchase_receipt'");
        console.log("purchase_receipt -> purchase fixed.");
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
