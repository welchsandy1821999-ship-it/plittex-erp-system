'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
});

const SQL = `UPDATE client_orders SET counterparty_id = 334 WHERE id = 140;`;

(async () => {
    try {
        const result = await pool.query(SQL);
        console.log('✅ Успешно! Обновлено заказов:', result.rowCount);
    } catch (err) {
        console.error('❌ Ошибка:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();