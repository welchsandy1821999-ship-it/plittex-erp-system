require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME
});

async function executePhase4() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('===== ШАГ 1: ХИРУРГИЯ QUANTITY (Округление до 2 знаков) =====');

        // 1. Округление в inventory_movements
        let updateMovements = await client.query(`
            UPDATE inventory_movements 
            SET quantity = ROUND(quantity::numeric, 2)
            WHERE quantity IS NOT NULL AND quantity != ROUND(quantity::numeric, 2)
        `);
        console.log(`Обновлено строк в inventory_movements: ${updateMovements.rowCount}`);

        // 2. Проверка и округление в item_balances, если такая таблица используется
        const checkItemBalances = await client.query(`
            SELECT table_name FROM information_schema.tables WHERE table_name = 'item_balances'
        `);
        
        if (checkItemBalances.rows.length > 0) {
            let updateBalances = await client.query(`
                UPDATE item_balances 
                SET balance = ROUND(balance::numeric, 2)
                WHERE balance IS NOT NULL AND balance != ROUND(balance::numeric, 2)
            `);
            console.log(`Обновлено строк в item_balances: ${updateBalances.rowCount}`);
        } else {
            console.log(`Таблица item_balances не обнаружена, пропускаем...`);
        }

        // Округление quantity в production_batches на всякий случай
        const checkProductionBatchesQty = await client.query(`
            SELECT column_name FROM information_schema.columns WHERE table_name = 'production_batches' AND column_name IN ('planned_quantity', 'actual_good_qty', 'actual_grade2_qty', 'actual_scrap_qty')
        `);
        if (checkProductionBatchesQty.rows.length > 0) {
            for (let col of checkProductionBatchesQty.rows) {
                let u = await client.query(`
                    UPDATE production_batches 
                    SET ${col.column_name} = ROUND(${col.column_name}::numeric, 2)
                    WHERE ${col.column_name} IS NOT NULL AND ${col.column_name} != ROUND(${col.column_name}::numeric, 2)
                `);
                if (u.rowCount > 0) console.log(`Обновлено строк в production_batches (${col.column_name}): ${u.rowCount}`);
            }
        }


        console.log('\n===== ШАГ 2: КОНТРОЛЬНЫЙ ВЫСТРЕЛ ПО ЩЕБНЮ (ID 157) =====');
        let checkSheben = await client.query(`
            SELECT 
                i.id, 
                i.name, 
                COALESCE(SUM(m.quantity), 0) as balance 
            FROM items i 
            LEFT JOIN inventory_movements m ON m.item_id = i.id 
            WHERE i.id = 157 
            GROUP BY i.id, i.name
        `);
        console.table(checkSheben.rows);

        await client.query('COMMIT');
        console.log('\n🎉 Транзакция ФАЗЫ 4 завершена успешно (COMMIT).');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ ОШИБКА: Произведен ROLLBACK. Причина:', err.message);
        console.error(err.stack);
    } finally {
        client.release();
        await pool.end();
    }
}

executePhase4();
