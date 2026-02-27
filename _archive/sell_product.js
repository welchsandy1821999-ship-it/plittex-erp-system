const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL', 
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

async function sellProduct() {
    console.log('Оформляем продажу клиенту...');
    const client = await pool.connect();

    try {
        // НАЧИНАЕМ СТРОГУЮ ТРАНЗАКЦИЮ
        await client.query('BEGIN');

        // Шаг 1: Добавляем розничного клиента в базу
        const customerRes = await client.query(
            `INSERT INTO counterparties (name, role, phone) 
             VALUES ($1, $2, $3) RETURNING id`,
            ['Иван Иванов (розница)', 'client', '+79991234567']
        );
        const customerId = customerRes.rows[0].id;
        console.log(`Клиент добавлен. ID: ${customerId}`);

        // Шаг 2: Принимаем наличные в кассу (Доход)
        await client.query(
            `INSERT INTO transactions (amount, transaction_type, payment_method, category, counterparty_id, description) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                12960.00,    // Сумма: 14.4 кв.м * 900 руб.
                'income',    // Тип: доход
                'cash',      // Способ: наличные
                'sales',     // Статья: продажи
                customerId,  // ID нашего Ивана
                'Оплата за 1 поддон белого Квадрата (наличные)'
            ]
        );

        // Шаг 3: Ищем ID нашей белой плитки
        const tileRes = await client.query("SELECT id FROM items WHERE name = 'Плитка КВАДРАТ 2.К.4 (Белая)'");
        const tileId = tileRes.rows[0].id;

        // Шаг 4: Списываем плитку со склада (Отгрузка)
        await client.query(
            `INSERT INTO inventory_movements (item_id, quantity, movement_type, description) 
             VALUES ($1, $2, $3, $4)`,
            [
                tileId, 
                -14.40,     // Минус! Плитка уезжает со склада
                'sale',     // Тип движения: продажа
                'Отгрузка клиенту Иван Иванов'
            ]
        );

        // СОХРАНЯЕМ ВСЕ ИЗМЕНЕНИЯ РАЗОМ
        await client.query('COMMIT');
        console.log('✅ Продажа успешна! 12 960 руб. в кассе, плитка отгружена.');

    } catch (err) {
        // Если ошибка - отменяем и деньги, и отгрузку
        await client.query('ROLLBACK');
        console.error('❌ Ошибка при продаже:', err.message);
    } finally {
        client.release(); 
        pool.end();       
    }
}

sellProduct();