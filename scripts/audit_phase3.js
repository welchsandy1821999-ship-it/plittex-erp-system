require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME
});

async function executePhase3() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('===== ШАГ 1: ХИРУРГИЯ ПИГМЕНТА =====');

        // 1. Delete buggy drafted movements (713, 717)
        let delBug = await client.query(`DELETE FROM inventory_movements WHERE id IN (713, 717)`);
        console.log(`Удалено баговых записей (713, 717): ${delBug.rowCount}`);

        // 2. Delete all initial and revision movements for item 161
        let delInitial = await client.query(`
            DELETE FROM inventory_movements 
            WHERE item_id = 161 
            AND movement_type IN ('initial', 'audit_adjustment', 'ревизия', 'revision', 'audit', 'initial_balance', 'correction', 'adjustment')
        `);
        console.log(`Удалено старых initial/ревизий пигмента: ${delInitial.rowCount}`);

        // 3. Insert specific initial balance for 161
        // Need to check the price just to set amount if we can, or amount=0. Price is 380, so 275 * 380 = 104500
        let item161 = await client.query(`SELECT current_price FROM items WHERE id = 161`);
        let currentPrice = item161.rows[0].current_price || 380;
        let amount = 275 * currentPrice;

        let insertInitial = await client.query(`
            INSERT INTO inventory_movements (item_id, warehouse_id, quantity, amount, movement_type, description, created_at)
            VALUES (161, 1, 275, $1, 'initial', 'Начальный остаток на 01.03.2026 (чистка ФАЗА 3)', '2026-03-01 00:00:00')
            RETURNING id
        `, [amount]);
        console.log(`Добавлен чистый initial пигмента: +275кг (ID: ${insertInitial.rows[0].id})`);

        // 4. Verification
        let verifyPigment = await client.query(`
            SELECT 
                SUM(CASE WHEN movement_type = 'initial' THEN quantity ELSE 0 END) as initial_qty,
                SUM(CASE WHEN movement_type = 'production_expense' THEN quantity ELSE 0 END) as prod_qty,
                SUM(quantity) as balance
            FROM inventory_movements 
            WHERE item_id = 161
        `);
        console.table(verifyPigment.rows);


        console.log('\n===== ШАГ 2: ГЛУБОКАЯ ЗАЧИСТКА ДРОБЕЙ (ОКРУГЛЕНИЕ ЦЕН) =====');

        // Rounding items price fields
        let updateItems = await client.query(`
            UPDATE items 
            SET current_price = ROUND(current_price::numeric, 2)
            WHERE current_price IS NOT NULL AND current_price != ROUND(current_price::numeric, 2)
        `);
        console.log(`Округлено current_price в items: ${updateItems.rowCount}`);

        // Checking inventory_movements columns...
        // amount is a numeric field. If there are others like cost or unit_price, let's round them.
        let colsDB = await client.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'inventory_movements'
        `);
        let moveCols = colsDB.rows.map(r => r.column_name);
        
        // Rounding amount
        if (moveCols.includes('amount')) {
            let updateAmount = await client.query(`
                UPDATE inventory_movements 
                SET amount = ROUND(amount::numeric, 2)
                WHERE amount IS NOT NULL AND amount != ROUND(amount::numeric, 2)
            `);
            console.log(`Округлено amount в inventory_movements: ${updateAmount.rowCount}`);
        }
        
        // Rounding unit_price or cost in inventory_movements if exists
        for (let c of ['cost', 'unit_price', 'price']) {
            if (moveCols.includes(c)) {
                let updateCost = await client.query(`
                    UPDATE inventory_movements 
                    SET ${c} = ROUND(${c}::numeric, 2)
                    WHERE ${c} IS NOT NULL AND ${c} != ROUND(${c}::numeric, 2)
                `);
                console.log(`Округлено ${c} в inventory_movements: ${updateCost.rowCount}`);
            }
        }

        // Rounding production_batches cost columns
        let pbColsDB = await client.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'production_batches'
        `);
        let pbCols = pbColsDB.rows.map(r => r.column_name);
        
        const targetPbCols = [
            'mat_cost_total', 'other_direct_costs', 'indirect_costs', 
            'labor_cost_total', 'overhead_cost_total', 'machine_amort_cost', 'mold_amort_cost'
        ];

        for (let col of targetPbCols) {
            if (pbCols.includes(col)) {
                let u = await client.query(`
                    UPDATE production_batches 
                    SET ${col} = ROUND(${col}::numeric, 2)
                    WHERE ${col} IS NOT NULL AND ${col} != ROUND(${col}::numeric, 2)
                `);
                console.log(`Округлено ${col} в production_batches: ${u.rowCount}`);
            }
        }


        console.log('\n===== ШАГ 3: СВЕРКА ОСТАЛЬНОГО СЫРЬЯ (READ-ONLY) =====');

        // Select materials that are not Sand (155, 156) and not Pigment (161)
        // Check balance and if they have manual revisions
        let rawMaterialsCheck = await client.query(`
            WITH MaterialStats AS (
                SELECT 
                    m.item_id,
                    i.name,
                    SUM(m.quantity) as current_balance,
                    COUNT(CASE WHEN m.movement_type = 'production_expense' THEN 1 END) as prod_usage_count,
                    COUNT(CASE WHEN m.movement_type IN ('audit_adjustment', 'ревизия', 'revision', 'audit') THEN 1 END) as revision_count
                FROM inventory_movements m
                JOIN items i ON m.item_id = i.id
                WHERE i.id NOT IN (155, 156, 161)
                  AND (i.item_type = 'material' OR i.item_type = 'raw_material' OR i.category ILIKE '%сырье%' OR i.category ILIKE '%материал%')
                GROUP BY m.item_id, i.name
            )
            SELECT 
                item_id as "Item ID",
                name as "Name",
                current_balance as "Current Balance",
                prod_usage_count as "Production Expenses",
                revision_count as "Manual Revisions",
                CASE WHEN revision_count > 0 THEN '⚠️ Yes' ELSE '✅ No' END as "Has Revisions"
            FROM MaterialStats
            WHERE prod_usage_count > 0 OR current_balance != 0
            ORDER BY revision_count DESC, name;
        `);

        if (rawMaterialsCheck.rows.length === 0) {
            console.log("Дополнительных материалов с производственными списаниями не найдено.");
        } else {
            console.table(rawMaterialsCheck.rows);
        }

        await client.query('COMMIT');
        console.log('\n🎉 Транзакция ФАЗЫ 3 завершена успешно (COMMIT).');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ ОШИБКА: Произведен ROLLBACK. Причина:', err.message);
        console.error(err.stack);
    } finally {
        client.release();
        await pool.end();
    }
}

executePhase3();
