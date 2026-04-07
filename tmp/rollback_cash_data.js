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
        console.log('🔄 Откатываем изменения данных...');
        
        await pool.query('UPDATE transactions SET account_id = NULL WHERE id = 15812');
        await pool.query('UPDATE transactions SET account_id = 13 WHERE id = 15884');
        await pool.query('UPDATE transactions SET account_id = 37 WHERE id = 15893');
        await pool.query('UPDATE transactions SET account_id = 38 WHERE id = 15900');
        
        console.log('✅ Балансы восстановлены.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Ошибка:', err.message);
        process.exit(1);
    }
}

run();
