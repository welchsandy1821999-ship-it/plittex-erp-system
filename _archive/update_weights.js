const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL',
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

async function updateWeights() {
    console.log('Настройка весовых параметров...');
    try {
        // Устанавливаем вес для плитки (примерно 90 кг на 1 кв.м. для 40мм толщины)
        await pool.query("UPDATE items SET weight_kg = 90.000 WHERE name = 'Плитка КВАДРАТ 2.К.4 (Белая)'");
        
        // Для материалов, которые учитываются в кг, вес всегда 1
        await pool.query("UPDATE items SET weight_kg = 1.000 WHERE unit = 'кг'");

        console.log('✅ Веса успешно обновлены!');
    } catch (err) {
        console.error('Ошибка:', err.message);
    } finally {
        pool.end();
    }
}

updateWeights();