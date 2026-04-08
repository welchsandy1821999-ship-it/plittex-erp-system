require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

// Имитируем то, что фронтенд отправляет в /api/recipes/sync-category
async function main() {
    // Получаем рецепт-источник (Бордюр дорожный 457)
    const srcRecipe = await pool.query("SELECT material_id, quantity_per_unit FROM recipes WHERE product_id = 457");
    console.log(`Source recipe: ${srcRecipe.rowCount} items`);
    
    // Имитируем payload как фронтенд (materialId как STRING!)
    const payloadFromFrontend = srcRecipe.rows.map(r => ({
        materialId: String(r.material_id),  // ФРОНТЕНД ОТПРАВЛЯЕТ СТРОКУ!
        qty: parseFloat(r.quantity_per_unit)
    }));
    console.log('Payload (as frontend sends):');
    payloadFromFrontend.forEach(p => console.log(`  materialId="${p.materialId}" (type=${typeof p.materialId}), qty=${p.qty}`));
    
    // Теперь имитируем sync-category логику бэкенда
    const targetId = 481; // Бордюр магистральный Гладкий Белый
    
    // Проверяем ПЕРЕД
    const beforeRecipe = await pool.query("SELECT r.material_id, i.name, r.quantity_per_unit FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1 ORDER BY i.name", [targetId]);
    console.log(`\nBEFORE target [${targetId}]: ${beforeRecipe.rowCount} items`);
    beforeRecipe.rows.forEach(r => console.log(`  [${r.material_id}] ${r.name}: ${r.quantity_per_unit}`));
    
    // Имитируем sync-category
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let mat of payloadFromFrontend) {
            console.log(`\n  Processing materialId="${mat.materialId}" qty=${mat.qty}...`);
            const checkRes = await client.query('SELECT 1 FROM recipes WHERE product_id = $1 AND material_id = $2', [targetId, mat.materialId]);
            console.log(`    Exists: ${checkRes.rows.length > 0}`);
            if (checkRes.rows.length > 0) {
                await client.query('UPDATE recipes SET quantity_per_unit = $1 WHERE product_id = $2 AND material_id = $3', [mat.qty, targetId, mat.materialId]);
                console.log(`    UPDATED`);
            } else {
                await client.query('INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)', [targetId, mat.materialId, mat.qty]);
                console.log(`    INSERTED`);
            }
        }
        await client.query('ROLLBACK'); // НЕ КОММИТИМ - просто тестируем
        console.log('\n=== ROLLBACK (тест завершен без изменений) ===');
    } catch(e) {
        await client.query('ROLLBACK');
        console.error('ERROR:', e.message);
    } finally {
        client.release();
    }
    
    await pool.end();
}
main();
