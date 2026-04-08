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
        // Ищем бордюр магистральный
        const target = await pool.query("SELECT id, name FROM items WHERE name ILIKE '%магистрал%' AND item_type = 'product' LIMIT 5");
        console.log('=== TARGET PRODUCTS (магистральный) ===');
        target.rows.forEach(r => console.log(`  [${r.id}] ${r.name}`));
        
        // Ищем бордюр дорожный белый — источник
        const source = await pool.query("SELECT id, name FROM items WHERE name ILIKE '%дорожный%Белый%' AND item_type = 'product' AND name ILIKE '%Гладк%' LIMIT 5");
        console.log('\n=== SOURCE (дорожный Гладкий Белый) ===');
        source.rows.forEach(r => console.log(`  [${r.id}] ${r.name}`));
        
        if (source.rows.length > 0 && target.rows.length > 0) {
            const srcId = source.rows[0].id;
            const tgtId = target.rows[0].id;
            
            // Рецепт источника
            const srcRecipe = await pool.query("SELECT r.material_id, i.name, r.quantity_per_unit FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1 ORDER BY i.name", [srcId]);
            console.log(`\n=== SOURCE RECIPE [${srcId}] (${srcRecipe.rowCount} items) ===`);
            srcRecipe.rows.forEach(r => console.log(`  [${r.material_id}] ${r.name}: ${r.quantity_per_unit}`));
            
            // Рецепт цели
            const tgtRecipe = await pool.query("SELECT r.material_id, i.name, r.quantity_per_unit FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1 ORDER BY i.name", [tgtId]);
            console.log(`\n=== TARGET RECIPE [${tgtId}] (${tgtRecipe.rowCount} items) ===`);
            tgtRecipe.rows.forEach(r => console.log(`  [${r.material_id}] ${r.name}: ${r.quantity_per_unit}`));
            
            // Разница
            console.log('\n=== DIFF ===');
            const srcMap = {};
            srcRecipe.rows.forEach(r => srcMap[r.material_id] = { name: r.name, qty: parseFloat(r.quantity_per_unit) });
            const tgtMap = {};
            tgtRecipe.rows.forEach(r => tgtMap[r.material_id] = { name: r.name, qty: parseFloat(r.quantity_per_unit) });
            
            let diffs = 0;
            for (const [id, s] of Object.entries(srcMap)) {
                if (!tgtMap[id]) {
                    console.log(`  MISSING in target: [${id}] ${s.name}: ${s.qty}`);
                    diffs++;
                } else if (tgtMap[id].qty !== s.qty) {
                    console.log(`  DIFFERS: [${id}] ${s.name}: src=${s.qty} tgt=${tgtMap[id].qty}`);
                    diffs++;
                }
            }
            for (const [id, t] of Object.entries(tgtMap)) {
                if (!srcMap[id]) {
                    console.log(`  EXTRA in target: [${id}] ${t.name}: ${t.qty}`);
                    diffs++;
                }
            }
            if (diffs === 0) console.log('  ✅ Рецепты идентичны!');
        }
    } catch (e) {
        console.error(e.message);
    } finally {
        await pool.end();
    }
}
main();
