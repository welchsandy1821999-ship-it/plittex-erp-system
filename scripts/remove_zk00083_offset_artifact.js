'use strict';
/**
 * Разовое удаление артефакта: ошибочный взаимозачёт 16 697,78 ₽ по ЗК-00083.
 * Только soft-delete (is_deleted), без reconcileOrderSettlement / recalcAccountBalances.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
});

const SQL = `
    UPDATE transactions
    SET is_deleted = true
    WHERE linked_order_id = (SELECT id FROM client_orders WHERE doc_number = 'ЗК-00083')
      AND category = 'Взаимозачет аванса'
      AND amount = 16697.78
`;

(async () => {
    try {
        const result = await pool.query(SQL);
        console.log('OK: обновлено строк:', result.rowCount);
        if (result.rowCount === 0) {
            console.warn('Предупреждение: ни одна строка не найдена. Проверьте doc_number, category и amount.');
        }
    } catch (err) {
        console.error('Ошибка:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
