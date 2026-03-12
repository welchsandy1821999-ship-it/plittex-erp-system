// === ФАЙЛ: routes/production.js (Бэкенд-маршруты Производства и Рецептур) ===
const express = require('express');
const router = express.Router();
const Big = require('big.js');

module.exports = function (pool, getWhId) {

    // ==========================================
    // 1. УПРАВЛЕНИЕ ЗАМЕСАМИ (ШАБЛОНЫ)
    // ==========================================
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
    // 2. ФИКСАЦИЯ СМЕНЫ ПРОИЗВОДСТВА (МАССОВО)
    // ==========================================
    router.post('/api/production', async (req, res) => {
        let { date, shiftName, products, materialsUsed } = req.body;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // 1. Очищаем массив сырья
            if (materialsUsed) {
                materialsUsed = materialsUsed.filter(m => m.id && String(m.id).trim() !== '');
            }

            // ЗАЩИТА ОТ ГОНКИ ДАННЫХ (RACE CONDITION): Блокируем сырье перед проверкой остатков
            if (materialsUsed && materialsUsed.length > 0) {
                const matIds = materialsUsed.map(m => m.id);
                // Блокируем карточки материалов, чтобы никто другой их не списал
                await client.query(`SELECT id FROM items WHERE id = ANY($1::int[]) FOR UPDATE`, [matIds]);
            }

            // 2. Подтягиваем актуальные цены
            let itemPrices = [];
            if (materialsUsed && materialsUsed.length > 0) {
                const matIds = materialsUsed.map(m => m.id);
                const itemsRes = await client.query(`SELECT id, current_price FROM items WHERE id = ANY($1::int[])`, [matIds]);
                itemPrices = itemsRes.rows;
            }

            // 3. Амортизация (строго LIMIT 1 для станка)
            const productIds = products.map(p => p.id);
            const prodInfoRes = await client.query(`
                SELECT i.id, i.amortization_per_cycle as manual_amort, (e.purchase_cost / NULLIF(e.planned_cycles, 0)) as mold_amort
                FROM items i LEFT JOIN equipment e ON i.mold_id = e.id
                WHERE i.id = ANY($1::int[])
            `, [productIds]);

            const machineRes = await client.query(`
                SELECT (purchase_cost / NULLIF(planned_cycles, 0)) as machine_amort 
                FROM equipment 
                WHERE equipment_type = 'machine' AND status = 'active' ORDER BY id ASC LIMIT 1
            `);
            const machineAmort = machineRes.rows.length > 0 ? parseFloat(machineRes.rows[0].machine_amort) || 0 : 0;
            const prodInfos = prodInfoRes.rows;

            const totalProductsVolume = products.reduce((sum, p) => sum + parseFloat(p.quantity), 0);

            // 5. Создаем партии
            const createdBatches = [];
            for (let p of products) {
                const batchNumber = `П-${date.replace(/-/g, '')}-${Math.floor(Math.random() * 1000)}`;
                const volumeFraction = totalProductsVolume > 0 ? (parseFloat(p.quantity) / totalProductsVolume) : 0;

                const pInfo = prodInfos.find(info => info.id == p.id);
                const manualAmort = pInfo ? (parseFloat(pInfo.manual_amort) || 0) : 0;
                const moldAmort = pInfo ? (parseFloat(pInfo.mold_amort) || 0) : 0;

                const actualMoldAmortPerCycle = manualAmort > 0 ? manualAmort : moldAmort;
                const totalMoldAmortCost = (parseFloat(p.cycles) || 0) * actualMoldAmortPerCycle;
                const totalMachineAmortCost = (parseFloat(p.cycles) || 0) * machineAmort;
                const totalAmortCost = totalMoldAmortCost + totalMachineAmortCost;

                const batchRes = await client.query(`
                    INSERT INTO production_batches 
                    (batch_number, product_id, planned_quantity, status, cycles_count, shift_name, mat_cost_total, overhead_cost_total, machine_amort_cost, mold_amort_cost)
                    VALUES ($1, $2, $3, 'in_drying', $4, $5, 0, $6, $7, $8) RETURNING id
                `, [batchNumber, p.id, p.quantity, p.cycles, shiftName, totalAmortCost, totalMachineAmortCost, totalMoldAmortCost]);

                createdBatches.push({
                    batchId: batchRes.rows[0].id, batchNumber: batchNumber, productId: p.id,
                    quantity: p.quantity, fraction: volumeFraction, accumulatedCost: 0
                });
            }

            // 6. Списываем сырье
            if (materialsUsed && materialsUsed.length > 0) {
                for (let mat of materialsUsed) {
                    const priceObj = itemPrices.find(p => p.id == mat.id);
                    const currentPrice = priceObj ? (parseFloat(priceObj.current_price) || 0) : 0;

                    for (let batch of createdBatches) {
                        const qtyForBatch = mat.qty * batch.fraction;
                        const costForBatch = qtyForBatch * currentPrice;

                        if (qtyForBatch > 0) {
                            batch.accumulatedCost += costForBatch;
                            await client.query(`
                                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
                                VALUES ($1, $2, 'production_expense', $3, 1, $4)
                            `, [mat.id, -qtyForBatch.toFixed(4), `Замес смены: Партия ${batch.batchNumber}`, batch.batchId]);
                        }
                    }
                }
            }

            // 7. Обновляем стоимость и приходуем в сушилку
            for (let batch of createdBatches) {
                await client.query(`UPDATE production_batches SET mat_cost_total = $1 WHERE id = $2`, [batch.accumulatedCost, batch.batchId]);
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
                    VALUES ($1, $2, 'production_receipt', $3, 3, $4)
                `, [batch.productId, batch.quantity, `Партия ${batch.batchNumber} (Сушка)`, batch.batchId]);
            }

            // 8. Списание ресурса оборудования
            let totalShiftCycles = 0;
            for (let batch of createdBatches) {
                const origProd = products.find(p => p.id === batch.productId);
                if (origProd && origProd.cycles > 0) {
                    totalShiftCycles += parseFloat(origProd.cycles);
                    if (origProd.mold_id) {
                        await client.query(`UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 WHERE id = $2 AND equipment_type = 'mold'`, [origProd.cycles, origProd.mold_id]);
                    }
                }
            }

            if (totalShiftCycles > 0) {
                await client.query(`UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 WHERE id = (SELECT id FROM equipment WHERE equipment_type = 'machine' AND status = 'active' ORDER BY id ASC LIMIT 1)`, [totalShiftCycles]);
                await client.query(`UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 WHERE id = (SELECT id FROM equipment WHERE equipment_type = 'pallets' AND status = 'active' ORDER BY id ASC LIMIT 1)`, [totalShiftCycles]);
            }

            await client.query('COMMIT');
            res.json({ success: true, message: 'Смена успешно зафиксирована' });

        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Ошибка фиксации:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // ==========================================
    // 3. ЕДИНИЧНОЕ ПРОИЗВОДСТВО (/api/produce)
    // ==========================================
    router.post('/api/produce', async (req, res) => {
        const { tileId, quantity, moisture = 0, defect = 0 } = req.body;
        if (parseFloat(quantity) <= 0 || isNaN(parseFloat(quantity))) return res.status(400).json({ error: 'Количество должно быть больше нуля!' });

        const userId = req.user ? req.user.id : null;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');
            const materialsWh = await getWhId(client, 'materials');
            const dryingWh = await getWhId(client, 'drying');

            const recipeRes = await client.query(`
                SELECT r.material_id, r.quantity_per_unit, i.name, i.current_price 
                FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1
            `, [tileId]);

            if (recipeRes.rows.length === 0) throw new Error('Рецепт не найден!');

            // ЗАЩИТА ОТ ГОНКИ ДАННЫХ: Блокируем сырье перед проверкой остатков
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

            await client.query('COMMIT');
            res.json({ success: true, message: `Партия ${batchNum} успешно запущена` });

        } catch (err) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally { client.release(); }
    });

    // ==========================================
    // 4. ИСТОРИЯ И АНАЛИТИКА ПАРТИЙ
    // ==========================================
    router.get('/api/production/history', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT pb.id, pb.batch_number, i.name as product_name, pb.planned_quantity, pb.mat_cost_total, pb.created_at
                FROM production_batches pb JOIN items i ON pb.product_id = i.id
                WHERE pb.created_at::date = $1 ORDER BY pb.id DESC
            `, [req.query.date]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
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

    router.delete('/api/production/batch/:id', async (req, res) => {
        const batchId = req.params.id;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const batchInfo = await client.query(`SELECT pb.cycles_count, i.mold_id FROM production_batches pb JOIN items i ON pb.product_id = i.id WHERE pb.id = $1`, [batchId]);
            if (batchInfo.rows.length > 0) {
                const cyclesToRevert = parseFloat(batchInfo.rows[0].cycles_count) || 0;
                const moldId = batchInfo.rows[0].mold_id;
                if (cyclesToRevert > 0) {
                    if (moldId) await client.query(`UPDATE equipment SET current_cycles = GREATEST(0, COALESCE(current_cycles, 0) - $1) WHERE id = $2 AND equipment_type = 'mold'`, [cyclesToRevert, moldId]);
                    await client.query(`UPDATE equipment SET current_cycles = GREATEST(0, COALESCE(current_cycles, 0) - $1) WHERE equipment_type IN ('machine', 'pallets') AND status = 'active'`, [cyclesToRevert]);
                }
            }
            await client.query('DELETE FROM inventory_movements WHERE batch_id = $1', [batchId]);
            await client.query('DELETE FROM production_batches WHERE id = $1', [batchId]);
            await client.query('COMMIT');
            res.json({ success: true, message: 'Формовка отменена' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
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

    // ==========================================
    // 5. РЕЦЕПТУРЫ
    // ==========================================
    router.get('/api/recipes/:productId', async (req, res) => {
        try {
            const result = await pool.query(`SELECT r.id, r.material_id, r.quantity_per_unit, i.name as material_name, i.unit, i.current_price FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1`, [req.params.productId]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/recipes/save', async (req, res) => {
        const { productId, productName, ingredients, force } = req.body;
        const client = await pool.connect();
        try {
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
                        return res.status(400).json({ warning: `⚠️ ВНИМАНИЕ! Вы указали Песок: ${newSand}кг, Щебень: ${newStone}кг.\nНо у аналогичной плитки (${baseForm}) стандартом идет Песок: ${oldSand}кг, Щебень: ${oldStone}кг.\nВозможно, ошибка в данных. Сохранить принудительно?` });
                    }
                }
            }

            await client.query('BEGIN');
            await client.query('DELETE FROM recipes WHERE product_id = $1', [productId]);
            for (let ing of ingredients) {
                await client.query(`INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`, [productId, ing.materialId, ing.qty]);
            }
            await client.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    router.post('/api/recipes/mass-copy', async (req, res) => {
        const { sourceProductId, targetProductIds } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const sourceRecipeRes = await client.query(`SELECT material_id, quantity_per_unit FROM recipes WHERE product_id = $1`, [sourceProductId]);
            if (sourceRecipeRes.rows.length === 0) throw new Error('Эталонный рецепт пуст!');

            for (let targetId of targetProductIds) {
                await client.query('DELETE FROM recipes WHERE product_id = $1', [targetId]);
                for (let ing of sourceRecipeRes.rows) {
                    await client.query(`INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`, [targetId, ing.material_id, ing.quantity_per_unit]);
                }
            }
            await client.query('COMMIT');
            res.json({ success: true, message: `Шаблон применен к ${targetProductIds.length} позициям.` });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    // ==========================================
    // УМНАЯ СИНХРОНИЗАЦИЯ РЕЦЕПТОВ ПО ВЫБРАННЫМ ID
    // ==========================================
    router.post('/api/recipes/sync-category', async (req, res) => {
        const { targetProductIds, materials } = req.body;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            if (!targetProductIds || targetProductIds.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Не выбраны товары для синхронизации.' });
            }

            // Обновляем базовые материалы для каждого выбранного товара
            for (let targetId of targetProductIds) {
                for (let mat of materials) {
                    const checkRes = await client.query(
                        `SELECT 1 FROM recipes WHERE product_id = $1 AND material_id = $2`,
                        [targetId, mat.materialId]
                    );

                    if (checkRes.rows.length > 0) {
                        await client.query(
                            `UPDATE recipes SET quantity_per_unit = $1 WHERE product_id = $2 AND material_id = $3`,
                            [mat.qty, targetId, mat.materialId]
                        );
                    } else {
                        await client.query(
                            `INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`,
                            [targetId, mat.materialId, mat.qty]
                        );
                    }
                }
            }

            await client.query('COMMIT');
            res.json({ success: true, message: `Успешно применено к ${targetProductIds.length} позициям.` });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Ошибка синхронизации рецептов:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // ==========================================
    // 6. ГЕНЕРАЦИЯ ПЕЧАТНОЙ ФОРМЫ (ПАСПОРТ)
    // ==========================================
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
        } catch (err) {
            res.status(500).send('Ошибка генерации паспорта: ' + err.message);
        }
    });

    return router;
};