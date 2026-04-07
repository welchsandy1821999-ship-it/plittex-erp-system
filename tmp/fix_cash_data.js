require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT
});

async function run() {
    try {
        console.log('🚀 Начинаем обновление данных транзакций...');
        
        // 1. Привязываем "потерянные" транзиты к Кассе 1
        const res = await pool.query(`
            UPDATE transactions 
            SET account_id = 1 
            WHERE id IN (15812, 15900, 15893, 15884)
            RETURNING id, amount, transaction_type;
        `);
        
        console.log('✅ Обновлено записей:', res.rowCount);
        res.rows.forEach(row => {
            console.log(`   - ID ${row.id}: ${row.amount} (${row.transaction_type}) -> Касса 1`);
        });

        process.exit(0);
    } catch (err) {
        console.error('❌ Ошибка при обновлении:', err.message);
        process.exit(1);
    }
}

run();
