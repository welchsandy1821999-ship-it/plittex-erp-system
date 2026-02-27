const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL', 
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

async function runProduction() {
    console.log('Запускаем бетоносмеситель и вибропресс...');
    
    // Подключаем специального "клиента" для работы с транзакцией
    const client = await pool.connect();

    try {
        // Шаг 1: Ищем ID цемента и ID белой плитки в нашей базе
        const cementRes = await client.query("SELECT id FROM items WHERE name = 'Цемент М500'");
        const tileRes = await client.query("SELECT id FROM items WHERE name = 'Плитка КВАДРАТ 2.К.4 (Белая)'");
        
        const cementId = cementRes.rows[0].id;
        const tileId = tileRes.rows[0].id;

        // Шаг 2: НАЧИНАЕМ СТРОГУЮ ТРАНЗАКЦИЮ
        await client.query('BEGIN');

        // Шаг 3: Списываем сырье (ЦЕМЕНТ) в МИНУС
        await client.query(
            `INSERT INTO inventory_movements (item_id, quantity, movement_type, description) 
             VALUES ($1, $2, $3, $4)`,
            [cementId, -300.00, 'production_expense', 'Списание цемента на партию белого Квадрата']
        );

        // Шаг 4: Оприходуем готовую продукцию (ПЛИТКУ) в ПЛЮС
        await client.query(
            `INSERT INTO inventory_movements (item_id, quantity, movement_type, description) 
             VALUES ($1, $2, $3, $4)`,
            [tileId, 14.40, 'production_receipt', 'Выпуск готовой продукции (1 поддон)']
        );

        // Шаг 5: ПОДТВЕРЖДАЕМ И СОХРАНЯЕМ ИЗМЕНЕНИЯ
        await client.query('COMMIT');
        console.log('✅ Производство завершено! 300 кг цемента списано, 14.4 кв.м плитки на складе.');

    } catch (err) {
        // Если где-то произошла ошибка - ОТМЕНЯЕМ ВСЁ
        await client.query('ROLLBACK');
        console.error('❌ Ошибка на линии! Транзакция отменена. Причина:', err.message);
    } finally {
        client.release(); // Освобождаем клиента
        pool.end();       // Закрываем базу
    }
}

runProduction();