// === ФАЙЛ: routes/production.js ===
const express = require('express');
const router = express.Router();
const Big = require('big.js');
const { sendNotify } = require('../utils/telegram');

// 👈 Добавили withTransaction
module.exports = function (pool, getWhId, withTransaction) {

    // --- ПРОСТЫЕ ЗАПРОСЫ ---
    router.get('/api/mix-templates', async (req, res) => {
        try {
            const result = await pool.query(`SELECT value FROM settings WHERE key = 'mix_templates'`);
            if (result.rows.length > 0) res.json(result.rows[0].value);
            else res.json({ big: [], small: [] });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/mix-templates', async (req, res) => {
        try {
            await pool.query(`
                INSERT INTO settings (key, value) VALUES ('mix_templates', $1)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            `, [JSON.stringify(req.body)]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });


    // ==========================================
    // ВРЕМЕННАЯ ТАБЛЕТКА: РАСШИРЕНИЕ ВСЕХ ЛИМИТОВ БД (ЧАСТЬ 2)
    // ==========================================
    router.get('/fix-db', async (req, res) => {
        try {
            await pool.query(`
                -- Добиваем финансовые колонки амортизации
                ALTER TABLE production_batches ALTER COLUMN machine_amort_cost TYPE NUMERIC(15,2);
                ALTER TABLE production_batches ALTER COLUMN mold_amort_cost TYPE NUMERIC(15,2);
                -- Расширяем колонку циклов в самой партии
                ALTER TABLE production_batches ALTER COLUMN cycles_count TYPE NUMERIC(15,2);
                -- На всякий случай расширяем цены в справочнике
                ALTER TABLE items ALTER COLUMN current_price TYPE NUMERIC(15,2);
                ALTER TABLE items ALTER COLUMN amortization_per_cycle TYPE NUMERIC(15,4);
            `);
            res.send('<h1>✅ Успешно (Часть 2)!</h1><p>Абсолютно все финансовые и количественные лимиты расширены до десятков миллионов.</p>');
        } catch (err) {
            res.send(`<h1>❌ Ошибка:</h1><p>${err.message}</p>`);
        }
    });

    router.get('/api/production/history', async (req, res) => {
        const { date } = req.query;
        try {
            const result = await pool.query(`
            SELECT 
                b.id,                -- 🚩 Убедитесь, что это INTEGER ID
                b.batch_number, 
                b.planned_quantity,  -- А это 50.00
                p.name as product_name,
                b.mat_cost_total
            FROM production_batches b
            JOIN items p ON b.product_id = p.id
            WHERE b.production_date = $1
            ORDER BY b.created_at DESC
        `, [date]);
            res.json(result.rows); // Должен возвращать МАССИВ
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message }); // Возвращает ОБЪЕКТ (причина ошибки .map)
        }
    });

    router.get('/api/production/batch/:id/materials', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT i.name, SUM(ABS(m.quantity)) as qty, i.unit, SUM(ABS(m.quantity) * i.current_price) as cost,
                       pb.planned_quantity, pb.overhead_cost_total, pb.machine_amort_cost, pb.mold_amort_cost
                FROM inventory_movements m JOIN items i ON m.item_id = i.id JOIN production_batches pb ON m.batch_id = pb.id
                WHERE m.batch_id = $1 AND m.movement_type = 'production_expense'
                GROUP BY i.name, i.unit, pb.planned_quantity, pb.overhead_cost_total, pb.machine_amort_cost, pb.mold_amort_cost
                ORDER BY cost DESC
            `, [req.params.id]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/production/in-drying', async (req, res) => {
        try {
            const result = await pool.query(`SELECT pb.id, pb.batch_number, pb.product_id, i.name as product_name, pb.planned_quantity, pb.created_at FROM production_batches pb JOIN items i ON pb.product_id = i.id WHERE pb.status = 'in_drying' ORDER BY pb.created_at ASC`);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/analytics/cost-deviation', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT created_at::date as date, batch_number, i.name as product_name,
                       ((pb.mat_cost_total + COALESCE(pb.labor_cost_total, 0) + COALESCE(pb.overhead_cost_total, 0)) / NULLIF(pb.planned_quantity, 0)) as planned_unit_cost,
                       ((pb.mat_cost_total + COALESCE(pb.labor_cost_total, 0) + COALESCE(pb.overhead_cost_total, 0)) / NULLIF(pb.actual_good_qty, 0)) as actual_unit_cost
                FROM production_batches pb LEFT JOIN items i ON pb.product_id = i.id
                WHERE pb.status = 'completed' ORDER BY pb.created_at ASC LIMIT 30
            `);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/recipes/:productId', async (req, res) => {
        try {
            const result = await pool.query(`SELECT r.id, r.material_id, r.quantity_per_unit, i.name as material_name, i.unit, i.current_price FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1`, [req.params.productId]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/print/passport', async (req, res) => {
        const { batchId } = req.query;
        try {
            const result = await pool.query(`
                SELECT pb.batch_number, pb.planned_quantity, pb.shift_name, 
                       TO_CHAR(pb.created_at, 'DD.MM.YYYY HH24:MI') as date_formatted,
                       i.name as product_name, i.unit, i.gost_mark 
                FROM production_batches pb
                JOIN items i ON pb.product_id = i.id
                WHERE pb.id = $1
            `, [batchId]);
            if (result.rows.length === 0) return res.status(404).send('Партия не найдена');
            res.render('docs/passport', { batch: result.rows[0] });
        } catch (err) { res.status(500).send('Ошибка генерации паспорта: ' + err.message); }
    });


    // --- ТРАНЗАКЦИОННЫЕ МАРШРУТЫ (БЕЗОПАСНЫЕ) ---
    router.post('/api/production', async (req, res) => {
        let { date, shiftName, products, materialsUsed } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                // [РЕШЕНИЕ 4] Валидация даты на бэкенде (на всякий случай)
                const requestDate = new Date(date);
                const today = new Date();
                today.setHours(23, 59, 59, 999);
                if (requestDate > today) throw new Error('Нельзя закрывать смену будущим числом.');

                // [РЕШЕНИЕ 1] Динамический поиск ID складов вместо хардкода (1 и 3)
                const materialsWh = await getWhId(client, 'materials'); // Обычно склад №1
                const dryingWh = await getWhId(client, 'drying');       // Обычно склад сушилки №3

                // [РЕШЕНИЕ 3] Жесткая очистка материалов от мусора и пустых ID
                if (materialsUsed) {
                    materialsUsed = materialsUsed.filter(m => m.id && String(m.id).trim() !== '' && !isNaN(m.id));
                }
                if (!products || products.length === 0) throw new Error('Список продукции пуст.');

                // 2. Проверка остатков
                if (materialsUsed && materialsUsed.length > 0) {
                    const matIds = materialsUsed.map(m => m.id);
                    await client.query(`SELECT id FROM items WHERE id = ANY($1::int[]) FOR UPDATE`, [matIds]);

                    // 🚀 ИСПРАВЛЕНИЕ ЗАДАЧИ №12: Проверяем остаток только на складе МАТЕРИАЛОВ
                    const stockRes = await client.query(`
                        SELECT item_id as id, SUM(quantity) as total_qty
                        FROM inventory_movements
                        WHERE item_id = ANY($1::int[]) AND warehouse_id = $2
                        GROUP BY item_id
                    `, [matIds, materialsWh]);

                    const namesRes = await client.query(`SELECT id, name FROM items WHERE id = ANY($1::int[])`, [matIds]);

                    let insufficient = [];
                    for (let mat of materialsUsed) {
                        const stockItem = stockRes.rows.find(s => s.id == mat.id);
                        const nameObj = namesRes.rows.find(n => n.id == mat.id);
                        const available = new Big(stockItem ? stockItem.total_qty : 0);
                        const required = new Big(mat.qty || 0);

                        if (required.gt(available)) {
                            const missing = required.minus(available);
                            insufficient.push(`${nameObj?.name || 'ID ' + mat.id}: не хватает ${missing.toFixed(2)}`);
                        }
                    }

                    if (insufficient.length > 0) {
                        const error = new Error('insufficient_stock');
                        error.details = insufficient.join('; ');
                        throw error;
                    }
                }

                // 3. Сбор цен и параметров (фиксируем цену на момент закрытия)
                const matIds = materialsUsed?.map(m => m.id) || [];
                const itemPricesRes = await client.query(`SELECT id, current_price FROM items WHERE id = ANY($1::int[])`, [matIds]);
                const itemPrices = itemPricesRes.rows;

                const productIds = products.map(p => p.id);
                const prodInfoRes = await client.query(`
                SELECT i.id, i.amortization_per_cycle as manual_amort, (e.purchase_cost / NULLIF(e.planned_cycles, 0)) as mold_amort, i.mold_id
                FROM items i LEFT JOIN equipment e ON i.mold_id = e.id
                WHERE i.id = ANY($1::int[])
            `, [productIds]);

                const machineRes = await client.query(`
                SELECT id, (purchase_cost / NULLIF(planned_cycles, 0)) as machine_amort 
                FROM equipment 
                WHERE equipment_type = 'machine' AND status = 'active' ORDER BY id ASC LIMIT 1
            `);
                const machineAmort = machineRes.rows.length > 0 ? parseFloat(machineRes.rows[0].machine_amort) || 0 : 0;
                const machineId = machineRes.rows.length > 0 ? machineRes.rows[0].id : null;

                // 4. Создание партий
                const totalVolume = products.reduce((sum, p) => sum + (parseFloat(p.quantity) || 0), 0);
                const createdBatches = [];
                let totalShiftCycles = 0;

                for (let p of products) {
                    const batchNum = `П-${date.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
                    const pQty = parseFloat(p.quantity) || 0;
                    const pCycles = parseFloat(p.cycles) || 0;
                    const fraction = totalVolume > 0 ? (pQty / totalVolume) : 0;

                    const pInfo = prodInfoRes.rows.find(info => info.id == p.id);
                    const actualAmort = (parseFloat(pInfo?.manual_amort) || 0) > 0 ? parseFloat(pInfo.manual_amort) : (parseFloat(pInfo?.mold_amort) || 0);

                    const moldCost = pCycles * actualAmort;
                    const machineCost = pCycles * machineAmort;
                    const safeOverhead = Math.round((moldCost + machineCost) * 100) / 100;

                    // [ИЗМЕНЕНИЕ] Добавлено поле production_date и параметр $9 в запрос
                    const bRes = await client.query(`
                    INSERT INTO production_batches 
                    (batch_number, product_id, planned_quantity, status, cycles_count, shift_name, mat_cost_total, overhead_cost_total, machine_amort_cost, mold_amort_cost, production_date)
                    VALUES ($1, $2, $3, 'in_drying', $4, $5, 0, $6, $7, $8, $9) RETURNING id
                `, [batchNum, p.id, pQty, pCycles, shiftName, safeOverhead, machineCost, moldCost, date]);

                    createdBatches.push({ id: bRes.rows[0].id, num: batchNum, productId: p.id, qty: pQty, fraction, accCost: new Big(0), moldId: pInfo?.mold_id });
                    if (pCycles > 0) totalShiftCycles += pCycles;
                }

                // 5. Списание сырья и приход
                for (let mat of (materialsUsed || [])) {
                    const price = itemPrices.find(p => p.id == mat.id)?.current_price || 0;
                    for (let b of createdBatches) {
                        const bQty = new Big(mat.qty).times(b.fraction);
                        if (bQty.gt(0)) {
                            b.accCost = b.accCost.plus(bQty.times(price));
                            // Используем materialsWh вместо "1"
                            await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) VALUES ($1, $2, 'production_expense', $3, $4, $5)`,
                                [mat.id, bQty.times(-1).toFixed(4), `Замес: Партия ${b.num}`, materialsWh, b.id]);
                        }
                    }
                }

                for (let b of createdBatches) {
                    await client.query(`UPDATE production_batches SET mat_cost_total = $1 WHERE id = $2`, [b.accCost.toFixed(2), b.id]);
                    // Используем dryingWh вместо "3"
                    await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) VALUES ($1, $2, 'production_receipt', $3, $4, $5)`,
                        [b.productId, Number(b.qty).toFixed(4), `Выпуск: Партия ${b.num}`, dryingWh, b.id]);

                    if (b.moldId && totalShiftCycles > 0) {
                        const bCycles = products.find(p => p.id == b.productId)?.cycles || 0;
                        await client.query(`UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 WHERE id = $2`, [bCycles, b.moldId]);
                    }
                }

                // 6. Оборудование
                if (totalShiftCycles > 0) {
                    if (machineId) await client.query(`UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 WHERE id = $2`, [totalShiftCycles, machineId]);

                    // [РЕШЕНИЕ 2] Обновляем износ только для активных поддонов, но не "всем подряд" без разбора
                    await client.query(`
                    UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 
                    WHERE equipment_type = 'pallets' AND status = 'active'
                `, [totalShiftCycles]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: 'Смена успешно зафиксирована' });
        } catch (err) {
            console.error('PROD ERROR:', err);
            const isStockErr = err.message === 'insufficient_stock';
            res.status(isStockErr ? 400 : 500).json({
                error: isStockErr ? 'Недостаточно сырья на складе' : err.message,
                details: err.details || null
            });
        }
    });

    router.post('/api/produce', async (req, res) => {
        const { tileId, quantity, moisture = 0, defect = 0 } = req.body;
        if (parseFloat(quantity) <= 0 || isNaN(parseFloat(quantity))) return res.status(400).json({ error: 'Количество должно быть больше нуля!' });
        const userId = req.user ? req.user.id : null;

        try {
            await withTransaction(pool, async (client) => {
                const materialsWh = await getWhId(client, 'materials');
                const dryingWh = await getWhId(client, 'drying');

                const recipeRes = await client.query(`
                    SELECT r.material_id, r.quantity_per_unit, i.name, i.current_price 
                    FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1
                `, [tileId]);

                if (recipeRes.rows.length === 0) throw new Error('Рецепт не найден!');

                const matIds = recipeRes.rows.map(r => r.material_id);
                await client.query(`SELECT id FROM items WHERE id = ANY($1::int[]) FOR UPDATE`, [matIds]);

                const qtyBig = new Big(quantity);
                const defectMultiplier = new Big(1).plus(new Big(defect).div(100));
                const grossQuantity = qtyBig.times(defectMultiplier);
                const ingredientsToSpend = [];

                for (let ing of recipeRes.rows) {
                    let needed = new Big(ing.quantity_per_unit).times(grossQuantity);
                    if (ing.name.toLowerCase().includes('песок') && moisture > 0) {
                        const moistureFactor = new Big(1).minus(new Big(moisture).div(100));
                        needed = needed.div(moistureFactor);
                    }

                    const stockRes = await client.query(`
                        SELECT SUM(quantity) as balance FROM inventory_movements 
                        WHERE item_id = $1 AND warehouse_id = $2
                    `, [ing.material_id, materialsWh]);

                    const currentBalance = new Big(stockRes.rows[0].balance || 0);
                    if (currentBalance.lt(needed)) throw new Error(`Недостаточно: ${ing.name} (Нужно ${needed.toFixed(2)}, есть ${currentBalance.toFixed(2)})`);

                    ingredientsToSpend.push({ id: ing.material_id, needed: needed, price: new Big(ing.current_price || 0) });
                }

                const dateStr = new Date().toISOString().split('T')[0];
                const countRes = await client.query(`SELECT COUNT(*) FROM production_batches WHERE created_at::date = CURRENT_DATE`);
                const batchNum = `${dateStr}-${(parseInt(countRes.rows[0].count) + 1).toString().padStart(2, '0')}`;

                const batchRes = await client.query(`
                    INSERT INTO production_batches (batch_number, product_id, planned_quantity, mat_cost_total, status)
                    VALUES ($1, $2, $3, 0, 'in_drying') RETURNING id
                `, [batchNum, tileId, quantity]);
                const batchId = batchRes.rows[0].id;

                let totalMatCost = new Big(0);
                for (let mat of ingredientsToSpend) {
                    totalMatCost = totalMatCost.plus(mat.needed.times(mat.price));
                    await client.query(`
                        INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id) 
                        VALUES ($1, $2, 'production_expense', $3, $4, $5, $6)
                    `, [mat.id, mat.needed.times(-1).toFixed(4), `Замес партии ${batchNum}`, materialsWh, batchId, userId]);
                }

                await client.query(`UPDATE production_batches SET mat_cost_total = $1 WHERE id = $2`, [totalMatCost.toFixed(2), batchId]);
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id) 
                    VALUES ($1, $2, 'production_receipt', $3, $4, $5, $6)
                `, [tileId, quantity, `Партия ${batchNum} (Сушка)`, dryingWh, batchId, userId]);
            });
            // === МАГИЯ WEBSOCKETS И TELEGRAM ===
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`⏳ <b>Производство запущено</b>\nПартия: ${batchNum}\nСырье списано, отправлено в сушилку.`);

            res.json({ success: true, message: `Партия успешно запущена` });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // ЗАДАЧА №8 (ПОЛНАЯ ВЕРСИЯ): УДАЛЕНИЕ С ОТКАТОМ ИЗНОСА И ВАЛИДАЦИЕЙ ID
    // ------------------------------------------------------------------
    router.delete('/api/production/batch/:id', async (req, res) => {
        const batchId = parseInt(req.params.id); // 🚀 Отсекаем ".00"

        if (isNaN(batchId)) {
            return res.status(400).json({ error: `Неверный формат ID: ${req.params.id}` });
        }

        try {
            await withTransaction(pool, async (client) => {
                // Теперь в запросе будет число 50 вместо строки "50.00"
                const batchRes = await client.query('SELECT product_id FROM production_batches WHERE id = $1', [batchId]);
                if (batchRes.rows.length === 0) throw new Error('Партия не найдена');
                const batch = batchRes.rows[0];

                // Удаляем движения по складу 
                await client.query('DELETE FROM inventory_movements WHERE batch_id = $1', [batchId]);

                // Откат износа формы 
                const itemRes = await client.query('SELECT mold_id FROM items WHERE id = $1', [batch.product_id]);
                const moldId = itemRes.rows[0]?.mold_id;

                if (moldId && batch.cycles_count > 0) {
                    await client.query(`
                    UPDATE equipment SET current_cycles = GREATEST(0, COALESCE(current_cycles, 0) - $1) 
                    WHERE id = $2
                `, [batch.cycles_count, moldId]);
                }
                await client.query('DELETE FROM inventory_movements WHERE batch_id = $1', [batchId]);
                await client.query('DELETE FROM production_batches WHERE id = $1', [batchId]);
            });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/api/recipes/save', async (req, res) => {
        const { productId, productName, ingredients, force } = req.body;
        try {
            await withTransaction(pool, async (client) => {
                let newSand = ingredients.find(i => i.name.toLowerCase().includes('песок'))?.qty || 0;
                let newStone = ingredients.find(i => i.name.toLowerCase().includes('щебень'))?.qty || 0;

                if (!force) {
                    const match = productName.match(/(\d\.[А-Я]+\.\d)/);
                    if (match) {
                        const baseForm = match[0];
                        const checkRes = await client.query(`SELECT r.quantity_per_unit, i.name FROM recipes r JOIN items i ON r.material_id = i.id JOIN items p ON r.product_id = p.id WHERE p.name LIKE $1 AND p.id != $2 AND (i.name ILIKE '%песок%' OR i.name ILIKE '%щебень%') LIMIT 10`, [`%${baseForm}%`, productId]);
                        let oldSand = checkRes.rows.find(r => r.name.toLowerCase().includes('песок'))?.quantity_per_unit || newSand;
                        let oldStone = checkRes.rows.find(r => r.name.toLowerCase().includes('щебень'))?.quantity_per_unit || newStone;

                        if (Math.abs(newSand - oldSand) > oldSand * 0.1 || Math.abs(newStone - oldStone) > oldStone * 0.1) {
                            throw new Error(`⚠️ ВНИМАНИЕ! Вы указали Песок: ${newSand}кг, Щебень: ${newStone}кг.\nНо у аналогичной плитки (${baseForm}) стандартом идет Песок: ${oldSand}кг, Щебень: ${oldStone}кг.\nВозможно, ошибка в данных. Сохранить принудительно?`);
                        }
                    }
                }

                await client.query('DELETE FROM recipes WHERE product_id = $1', [productId]);
                for (let ing of ingredients) {
                    await client.query(`INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`, [productId, ing.materialId, ing.qty]);
                }
            });
            res.json({ success: true });
        } catch (err) {
            // Если ошибка проверки (force), отдаем статус 400 чтобы фронт показал Confirm
            if (err.message.includes('ВНИМАНИЕ!')) {
                res.status(400).json({ warning: err.message });
            } else {
                res.status(500).json({ error: err.message });
            }
        }
    });

    router.post('/api/recipes/mass-copy', async (req, res) => {
        const { sourceProductId, targetProductIds } = req.body;
        try {
            await withTransaction(pool, async (client) => {
                const sourceRecipeRes = await client.query(`SELECT material_id, quantity_per_unit FROM recipes WHERE product_id = $1`, [sourceProductId]);
                if (sourceRecipeRes.rows.length === 0) throw new Error('Эталонный рецепт пуст!');

                for (let targetId of targetProductIds) {
                    await client.query('DELETE FROM recipes WHERE product_id = $1', [targetId]);
                    for (let ing of sourceRecipeRes.rows) {
                        await client.query(`INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`, [targetId, ing.material_id, ing.quantity_per_unit]);
                    }
                }
            });
            res.json({ success: true, message: `Шаблон применен к ${targetProductIds.length} позициям.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/api/recipes/sync-category', async (req, res) => {
        const { targetProductIds, materials } = req.body;
        try {
            await withTransaction(pool, async (client) => {
                if (!targetProductIds || targetProductIds.length === 0) throw new Error('Не выбраны товары для синхронизации.');

                for (let targetId of targetProductIds) {
                    for (let mat of materials) {
                        const checkRes = await client.query(`SELECT 1 FROM recipes WHERE product_id = $1 AND material_id = $2`, [targetId, mat.materialId]);
                        if (checkRes.rows.length > 0) {
                            await client.query(`UPDATE recipes SET quantity_per_unit = $1 WHERE product_id = $2 AND material_id = $3`, [mat.qty, targetId, mat.materialId]);
                        } else {
                            await client.query(`INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`, [targetId, mat.materialId, mat.qty]);
                        }
                    }
                }
            });
            res.json({ success: true, message: `Успешно применено к ${targetProductIds.length} позициям.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // НОВЫЙ МАРШРУТ: СВОДНЫЙ ПЛАН И ОБЩИЙ ДЕФИЦИТ СЫРЬЯ (MRP)
    // ------------------------------------------------------------------
    router.get('/api/production/mrp-summary', async (req, res) => {
        try {
            // 1. Собираем все невыполненные задачи из planned_production
            // Учитываем только заказы со статусом pending или processing
            const planRes = await pool.query(`
                SELECT 
                    pp.item_id, 
                    i.name as item_name, 
                    i.unit, 
                    SUM(pp.quantity) as total_needed_qty
                FROM planned_production pp
                JOIN items i ON pp.item_id = i.id
                JOIN client_order_items coi ON pp.order_item_id = coi.id
                JOIN client_orders co ON coi.order_id = co.id
                WHERE co.status IN ('pending', 'processing')
                GROUP BY pp.item_id, i.name, i.unit
                ORDER BY total_needed_qty DESC
            `);

            const productionPlan = planRes.rows;
            const materialsNeeded = {};

            // 2. Рассчитываем общую потребность в материалах по рецептам
            for (let prod of productionPlan) {
                // ВАЖНО: используем правильное название колонки quantity_per_unit
                const recipeRes = await pool.query(
                    `SELECT material_id, quantity_per_unit FROM recipes WHERE product_id = $1`,
                    [prod.item_id]
                );

                for (let mat of recipeRes.rows) {
                    const totalForThisProd = parseFloat(mat.quantity_per_unit) * parseFloat(prod.total_needed_qty);
                    if (!materialsNeeded[mat.material_id]) materialsNeeded[mat.material_id] = 0;
                    materialsNeeded[mat.material_id] += totalForThisProd;
                }
            }

            // 3. Сопоставляем с остатками на Складе №1 (Сырье)
            const deficitReport = [];
            for (let matId in materialsNeeded) {
                const stockRes = await pool.query(`
                    SELECT i.name, i.unit, COALESCE(SUM(m.quantity), 0) as balance
                    FROM items i
                    LEFT JOIN inventory_movements m ON i.id = m.item_id AND m.warehouse_id = 1
                    WHERE i.id = $1
                    GROUP BY i.name, i.unit
                `, [matId]);

                if (stockRes.rows.length > 0) {
                    const row = stockRes.rows[0];
                    const needed = materialsNeeded[matId];
                    const balance = parseFloat(row.balance);

                    deficitReport.push({
                        name: row.name,
                        unit: row.unit,
                        needed: needed.toFixed(2),
                        stock: balance.toFixed(2),
                        shortage: (needed > balance) ? (needed - balance).toFixed(2) : 0
                    });
                }
            }

            res.json({
                success: true,
                productionPlan,
                deficitReport
            });
        } catch (err) {
            console.error('Ошибка MRP:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};