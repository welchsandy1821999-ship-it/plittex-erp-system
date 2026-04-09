require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME
});

async function fixSand() {
    const client = await pool.connect();
    try {
        console.log('===== РАЗБОР ПОЛЕТОВ: Песок основной (ID 155) =====');
        
        let sum = await client.query('SELECT SUM(quantity) as calc_balance FROM inventory_movements WHERE item_id = 155');
        console.log(`Текущий точный баланс: ${sum.rows[0].calc_balance}`);

        let moves = await client.query('SELECT id, movement_type, quantity FROM inventory_movements WHERE item_id = 155 ORDER BY quantity DESC LIMIT 5');
        console.table(moves.rows);

        if (Number(sum.rows[0].calc_balance) === -0.01) {
            console.log('\nКорректируем начальный остаток (+0.01)...');
            await client.query(`
                UPDATE inventory_movements 
                SET quantity = quantity + 0.01 
                WHERE item_id = 155 AND movement_type = 'initial'
            `);
            
            let newSum = await client.query('SELECT SUM(quantity) as new_balance FROM inventory_movements WHERE item_id = 155');
            console.log(`✅ Новый баланс: ${newSum.rows[0].new_balance}`);
        } else {
            console.log('Баланс не равен -0.01. Требуется анализ.');
        }

    } catch (err) {
        console.error('ERROR:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

fixSand();
