const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL',
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

async function setupRecipes() {
    console.log('Настраиваем рецептуру...');
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Шаг 1: Добавляем Песок и Пигмент в номенклатуру
        const sandRes = await client.query(
            `INSERT INTO items (name, item_type, unit, current_price) VALUES ($1, $2, $3, $4) RETURNING id`,
            ['Песок мытый', 'material', 'кг', 0.80]
        );
        const pigmentRes = await client.query(
            `INSERT INTO items (name, item_type, unit, current_price) VALUES ($1, $2, $3, $4) RETURNING id`,
            ['Пигмент белый (Диоксид титана)', 'material', 'кг', 250.00]
        );

        const sandId = sandRes.rows[0].id;
        const pigmentId = pigmentRes.rows[0].id;

        // Шаг 2: Находим ID цемента и ID белой плитки (которые мы создавали раньше)
        const cementRes = await client.query("SELECT id FROM items WHERE name = 'Цемент М500'");
        const tileRes = await client.query("SELECT id FROM items WHERE name = 'Плитка КВАДРАТ 2.К.4 (Белая)'");

        const cementId = cementRes.rows[0].id;
        const tileId = tileRes.rows[0].id;

        // Шаг 3: Прописываем РЕЦЕПТ для 1 кв.м. Белого Квадрата
        await client.query(
            `INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES 
            ($1, $2, $3),
            ($4, $5, $6),
            ($7, $8, $9)`,
            [
                tileId, cementId, 20.8300,  // $1, $2, $3
                tileId, sandId, 45.0000,    // $4, $5, $6
                tileId, pigmentId, 0.5000   // $7, $8, $9
            ]
        );

        // Шаг 4: Сразу закинем песок и пигмент на склад, чтобы было из чего производить
        await client.query(
            `INSERT INTO inventory_movements (item_id, quantity, movement_type, description) VALUES 
            ($1, $2, $3, $4), 
            ($5, $6, $7, $8)`,
            [
                sandId, 50000, 'receipt', 'Начальный остаток песка',
                pigmentId, 100, 'receipt', 'Начальный остаток пигмента'
            ]
        );

        await client.query('COMMIT');
        console.log('✅ Рецептура создана! Сырье добавлено на склад.');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Ошибка:', err.message);
    } finally {
        client.release();
        pool.end();
    }
}

setupRecipes();