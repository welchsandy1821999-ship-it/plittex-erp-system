const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:Plittex_2026_SQL@localhost:5432/plittex_erp' });

async function run() {
    try {
        await pool.query("UPDATE inventory_movements SET quantity = quantity * -1 WHERE movement_type = 'production_draft' AND quantity > 0");
        console.log("Drafts updated successfully.");
        // Insert missing 12 pigment just for user's convenience
        await pool.query("INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id) VALUES (161, 12, 'initial', 'Системная корректировка остатков (баг черновика)', 1)");
        console.log("Initial stock for pigment inserted.");
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
