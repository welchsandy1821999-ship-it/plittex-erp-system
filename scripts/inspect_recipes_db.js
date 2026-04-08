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
    try {
        // 1. Schema
        const schema = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'recipes'");
        console.log('=== SCHEMA recipes ===');
        schema.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));
        
        // 2. Sample data
        const sample = await pool.query("SELECT r.product_id, i.name as product_name, r.material_id, m.name as material_name, r.quantity_per_unit FROM recipes r JOIN items i ON r.product_id = i.id JOIN items m ON r.material_id = m.id LIMIT 10");
        console.log('\n=== SAMPLE recipes (10 rows) ===');
        sample.rows.forEach(r => console.log(`  product ${r.product_id} (${r.product_name}) -> material ${r.material_id} (${r.material_name}): ${r.quantity_per_unit}`));
        
        // 3. Count by product
        const counts = await pool.query("SELECT r.product_id, i.name, COUNT(*) as cnt FROM recipes r JOIN items i ON r.product_id = i.id GROUP BY r.product_id, i.name ORDER BY i.name LIMIT 20");
        console.log('\n=== RECIPES BY PRODUCT (first 20) ===');
        counts.rows.forEach(r => console.log(`  [${r.product_id}] ${r.name}: ${r.cnt} ingredients`));
        
    } catch (e) {
        console.error(e.message);
    } finally {
        await pool.end();
    }
}
main();
