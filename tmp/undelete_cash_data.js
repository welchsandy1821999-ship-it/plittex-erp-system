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
        console.log('✨ Воскрешаем удаленные транзиты для сверки с Турбо9...');
        
        const ids = [15811, 15812, 15892, 15893, 15899, 15900];
        await pool.query('UPDATE transactions SET is_deleted = false WHERE id = ANY($1)', [ids]);
        
        console.log('✅ Данные восстановлены.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Ошибка:', err.message);
        process.exit(1);
    }
}

run();
