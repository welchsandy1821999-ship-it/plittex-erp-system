const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL', 
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

async function makePayment() {
    console.log('Начинаем проведение платежа...');

    try {
        // ШАГ 1: Добавляем поставщика цемента в базу
        // Команда RETURNING id сразу вернет нам номер, который база присвоила этому поставщику
        const supplierResult = await pool.query(
            `INSERT INTO counterparties (name, role, inn) 
             VALUES ($1, $2, $3) 
             RETURNING id`,
            ['ООО "Цемент-Юг"', 'supplier', '2311000000']
        );
        
        // Достаем этот ID из ответа базы
        const supplierId = supplierResult.rows[0].id;
        console.log(`Поставщик успешно создан. Ему присвоен ID: ${supplierId}`);

        // ШАГ 2: Фиксируем списание денег с расчетного счета этому поставщику
        await pool.query(
            `INSERT INTO transactions 
            (amount, transaction_type, payment_method, category, counterparty_id, description) 
            VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                125000.00,       // Сумма (amount)
                'expense',       // Тип: расход (transaction_type)
                'bank',          // Способ: безнал (payment_method)
                'materials',     // Статья: сырье (category)
                supplierId,      // Тот самый ID поставщика (counterparty_id)
                'Оплата за 10 тонн цемента по счету №45' // Комментарий (description)
            ]
        );

        console.log('✅ Платеж на сумму 125 000 руб. успешно проведен!');

    } catch (err) {
        console.error('Ошибка при проведении операции:', err.message);
    } finally {
        pool.end(); // Обязательно закрываем соединение
    }
}

makePayment();