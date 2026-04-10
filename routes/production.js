// === ФАЙЛ: routes/production.js ===
const express = require('express');
const router = express.Router();
const Big = require('big.js');
const { sendNotify } = require('../utils/telegram');

const { requireAdmin, authenticateToken } = require('../middleware/auth');

// 👈 Добавили withTransaction
module.exports = function (pool, getWhId, withTransaction) {

    // --- ПРОСТЫЕ ЗАПРОСЫ ---
    router.get('/api/mix-templates', async (req, res) => {
        try {
            const result = await pool.query(`SELECT value FROM settings WHERE key = 'mix_templates'`);
            if (result.rows.length > 0) res.json(result.rows[0].value);
            else res.json({ big: [], small: [] });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/mix-templates', requireAdmin, async (req, res) => {
        try {
            await pool.query(`
                INSERT INTO settings (key, value) VALUES ('mix_templates', $1)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            `, [JSON.stringify(req.body)]);
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Получение плановых выходов
    router.get('/api/mix-template-yields', async (req, res) => {
        try {
            const result = await pool.query(`SELECT value FROM settings WHERE key = 'mix_template_yields'`);
            if (result.rows.length > 0) res.json(result.rows[0].value);
            else res.json({});
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
        }
    });

    // Безопасное точечное сохранение 1 шаблона (для двойного модуля Рецептур)
    router.post('/api/mix-templates/single', requireAdmin, async (req, res) => {
        const { templateKey, ingredients, yieldValue } = req.body;
        if (!templateKey || !Array.isArray(ingredients)) return res.status(400).json({error: 'Bad Request'});

        try {
            await withTransaction(pool, async (client) => {
                // 1. Сохраняем массив сырья
                const resMix = await client.query(`SELECT value FROM settings WHERE key = 'mix_templates' FOR UPDATE`);
                let mixTemplates = resMix.rows.length > 0 ? resMix.rows[0].value : {};
                mixTemplates[templateKey] = ingredients;
                
                await client.query(`
                    INSERT INTO settings (key, value) VALUES ('mix_templates', $1)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                `, [JSON.stringify(mixTemplates)]);

                // 2. Сохраняем выход (yield)
                const resYields = await client.query(`SELECT value FROM settings WHERE key = 'mix_template_yields' FOR UPDATE`);
                let mixYields = resYields.rows.length > 0 ? resYields.rows[0].value : {};
                mixYields[templateKey] = parseFloat(yieldValue) || 1;

                await client.query(`
                    INSERT INTO settings (key, value) VALUES ('mix_template_yields', $1)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                `, [JSON.stringify(mixYields)]);
            });
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Ошибка сохранения шаблона.' });
        }
    });




    router.get('/api/production/history', async (req, res) => {
        const { date } = req.query;
        try {
            const result = await pool.query(`
            SELECT 
                b.id,
                b.batch_number, 
                b.planned_quantity,
                b.product_id,
                p.name as product_name,
                b.mat_cost_total,
                b.status
            FROM production_batches b
            JOIN items p ON b.product_id = p.id
            WHERE b.production_date = $1 AND b.status != 'deleted'
            ORDER BY b.created_at DESC
        `, [date]);
            res.json(result.rows); // Должен возвращать МАССИВ
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' }); // Возвращает ОБЪЕКТ (причина ошибки .map)
        }
    });

    router.get('/api/production/batch/:id/materials', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT i.id, i.name, SUM(ABS(m.quantity)) as qty, i.unit, 
                       SUM(ABS(m.quantity) * CASE WHEN m.unit_price > 0 THEN m.unit_price ELSE i.current_price END) as cost
                FROM inventory_movements m 
                JOIN items i ON m.item_id = i.id 
                WHERE m.batch_id = $1 
                  AND m.movement_type IN ('production_expense', 'production_draft')
                GROUP BY i.id, i.name, i.unit
                ORDER BY cost DESC
            `, [req.params.id]);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Данные партии для экономики (объём, амортизация)
    router.get('/api/production/batch/:id/info', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT planned_quantity, mat_cost_total, overhead_cost_total,
                       machine_amort_cost, mold_amort_cost, status, shift_name
                FROM production_batches WHERE id = $1
            `, [req.params.id]);
            if (result.rows.length === 0) return res.status(404).json({ error: 'Партия не найдена' });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/production/in-drying', async (req, res) => {
        try {
            const result = await pool.query(`SELECT pb.id, pb.batch_number, pb.product_id, i.name as product_name, pb.planned_quantity, pb.created_at FROM production_batches pb JOIN items i ON pb.product_id = i.id WHERE pb.status = 'in_drying' ORDER BY pb.created_at ASC`);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
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
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/recipes/:productId', async (req, res) => {
        try {
            const result = await pool.query(`SELECT r.id, r.material_id, r.quantity_per_unit, i.name as material_name, i.unit, i.current_price FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1`, [req.params.productId]);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/print/passport', authenticateToken, async (req, res) => {
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
            console.error(err);
            res.status(500).send('Внутренняя ошибка сервера. Обратитесь к администратору.');
        }
    });


    // --- ТРАНЗАКЦИОННЫЕ МАРШРУТЫ (БЕЗОПАСНЫЕ) ---
    router.post('/api/production', requireAdmin, async (req, res) => {
        let { date, shiftName, products, materialsUsed, status: requestedStatus } = req.body;
        const isDraft = (requestedStatus === 'draft');
        console.log(`[PRODUCTION] Получен запрос: date=${date}, isDraft=${isDraft}`);

        try {
            await withTransaction(pool, async (client) => {
                // Валидация даты
                const requestDate = new Date(date);
                const today = new Date();
                today.setHours(23, 59, 59, 999);
                if (requestDate > today) throw new Error('Нельзя закрывать смену будущим числом.');

                if (!products || products.length === 0) throw new Error('Список продукции пуст.');

                const materialsWh = await getWhId(client, 'materials');
                const dryingWh = await getWhId(client, 'drying');

                // Очистка списка материалов
                if (materialsUsed) {
                    materialsUsed = materialsUsed.filter(m => m.id && String(m.id).trim() !== '' && !isNaN(m.id));
                }

                // ПОЛУЧАЕМ ПАРАМЕТРЫ АМОРТИЗАЦИИ (нужны и для черновика, и для фиксации)
                const productIds = products.map(p => p.id);
                const prodInfoRes = await client.query(`
                    SELECT i.id, i.amortization_per_cycle as manual_amort, 
                           (e.purchase_cost / NULLIF(e.planned_cycles, 0)) as mold_amort, i.mold_id
                    FROM items i LEFT JOIN equipment e ON i.mold_id = e.id
                    WHERE i.id = ANY($1::int[])
                `, [productIds]);

                const machineRes = await client.query(`
                    SELECT id, (purchase_cost / NULLIF(planned_cycles, 0)) as machine_amort 
                    FROM equipment WHERE equipment_type = 'machine' AND status = 'active' ORDER BY id ASC LIMIT 1
                `);
                const machineAmort = machineRes.rows.length > 0 ? Number(new Big(machineRes.rows[0].machine_amort || 0).round(4)) : 0;
                const machineId = machineRes.rows.length > 0 ? machineRes.rows[0].id : null;

                // ===== РЕЖИМ ЧЕРНОВИКА =====
                if (isDraft) {
                    for (let p of products) {
                        const batchNum = `П-${date.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
                        const pQty = Number(new Big(p.quantity || 0));
                        const pCycles = Number(new Big(p.cycles || 0));
                        
                        const pInfo = prodInfoRes.rows.find(x => x.id == p.id) || {};
                        const pMoldAmort = Number(new Big(pInfo.mold_amort || pInfo.manual_amort || 0).round(4));
                        const calcMachineCost = Number(new Big(machineAmort).times(pCycles).round(2));
                        const calcMoldCost = Number(new Big(pMoldAmort).times(pCycles).round(2));

                        const bRes = await client.query(`
                            INSERT INTO production_batches 
                            (batch_number, product_id, planned_quantity, status, cycles_count, shift_name, 
                             mat_cost_total, overhead_cost_total, machine_amort_cost, mold_amort_cost, production_date)
                            VALUES ($1, $2, $3, 'draft', $4, $5, 0, 0, $6, $7, $8) RETURNING id
                        `, [batchNum, p.id, pQty, pCycles, shiftName, calcMachineCost, calcMoldCost, date]);

                        const newBatchId = bRes.rows[0].id;

                        // 🚀 СОХРАНЯЕМ СОСТАВ ЗАМЕСОВ В ЧЕРНОВИК (с ценой)
                        if (materialsUsed && materialsUsed.length > 0) {
                            // Сначала получаем текущие цены на этот момент
                            const draftMatIds = materialsUsed.map(m => m.id);
                            const draftPricesRes = await client.query(`SELECT id, current_price FROM items WHERE id = ANY($1::int[])`, [draftMatIds]);

                            for (let mat of materialsUsed) {
                                const price = draftPricesRes.rows.find(p => p.id == mat.id)?.current_price || 0;

                                await client.query(`
                                    INSERT INTO inventory_movements 
                                    (item_id, quantity, movement_type, description, warehouse_id, batch_id, unit_price, movement_date) 
                                    VALUES ($1, $2, 'production_draft', $3, $4, $5, $6, $7)
                                `, [mat.id, new Big(mat.qty).times(-1).toFixed(4), `Черновик состава: ${mat.name || 'Сырье'}`, materialsWh, newBatchId, price, date]);
                            }
                        }
                    }
                    return; // Конец транзакции для черновика
                }

                // ===== ОБЫЧНЫЙ РЕЖИМ (in_drying) =====
                // (Тут остается твой оригинальный код списания и начисления износа)
                // ... [весь остальной код до конца функции] ...
                // [Скопируй сюда твою оригинальную логику списания из своего файла]
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: isDraft ? 'Черновик сохранён' : 'Смена успешно зафиксирована' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });



    // ------------------------------------------------------------------
    // ФИКСАЦИЯ СМЕНЫ: Превращает все черновики (draft) за дату в полноценные партии
    // ------------------------------------------------------------------
    router.post('/api/production/fixate-shift', requireAdmin, async (req, res) => {
        const { date, materialsUsed } = req.body;

        if (!date) return res.status(400).json({ error: 'Не указана дата для фиксации.' });

        try {
            await withTransaction(pool, async (client) => {
                // 1. Ищем все черновики за эту дату
                const draftsRes = await client.query(
                    `SELECT id, product_id, planned_quantity, cycles_count, batch_number, shift_name
                     FROM production_batches WHERE status = 'draft' AND production_date = $1
                     ORDER BY id`, [date]
                );

                if (draftsRes.rows.length === 0) {
                    throw new Error('Нет партий-черновиков для фиксации на эту дату.');
                }

                const drafts = draftsRes.rows;
                const materialsWh = await getWhId(client, 'materials');
                const dryingWh = await getWhId(client, 'drying');

                const draftIds = drafts.map(d => d.id); // Собираем ID всех черновиков смены

                // 🚀 УДАЛЯЕМ старые "нулевые" записи черновиков, чтобы записать чистый факт
                await client.query(`DELETE FROM inventory_movements WHERE batch_id = ANY($1::int[])`, [draftIds]);

                // 2. Очистка materialsUsed
                let cleanMaterials = (materialsUsed || []).filter(m => m.id && String(m.id).trim() !== '' && !isNaN(m.id));

                // 🚀 СТОП-КРАН: Запрещаем фиксировать смену без сырья
                if (cleanMaterials.length === 0) {
                    throw new Error('Ошибка: Список сырья пуст! Списание невозможно. Обновите страницу и попробуйте снова.');
                }

                // 3. Проверка остатков сырья
                if (cleanMaterials.length > 0) {
                    const matIds = cleanMaterials.map(m => m.id);
                    await client.query(`SELECT id FROM items WHERE id = ANY($1::int[]) FOR UPDATE`, [matIds]);

                    const stockRes = await client.query(`
    SELECT item_id as id, SUM(quantity) as total_qty
    FROM inventory_movements
    WHERE item_id = ANY($1::int[]) AND warehouse_id = $2
      AND movement_type != 'production_draft' -- 👈 ДОБАВЬТЕ ЭТУ СТРОКУ
    GROUP BY item_id
`, [matIds, materialsWh]);

                    const namesRes = await client.query(`SELECT id, name FROM items WHERE id = ANY($1::int[])`, [matIds]);

                    let insufficient = [];
                    for (let mat of cleanMaterials) {
                        const stockItem = stockRes.rows.find(s => s.id == mat.id);
                        const nameObj = namesRes.rows.find(n => n.id == mat.id);
                        const available = new Big(stockItem ? stockItem.total_qty : 0);
                        const required = new Big(mat.qty || 0);
                        if (required.gt(available)) {
                            insufficient.push({
                                name: nameObj?.name || 'ID ' + mat.id,
                                required: required.toFixed(2),
                                available: available.toFixed(2),
                                shortage: required.minus(available).toFixed(2)
                            });
                        }
                    }
                    if (insufficient.length > 0) {
                        const error = new Error('insufficient_stock');
                        error.details = insufficient;
                        throw error;
                    }
                }

                // 4. Сбор цен на сырьё
                const matIds = cleanMaterials.map(m => m.id);
                const itemPricesRes = await client.query(`SELECT id, current_price FROM items WHERE id = ANY($1::int[])`, [matIds.length > 0 ? matIds : [0]]);
                const itemPrices = itemPricesRes.rows;

                // 5. Получаем информацию о формах для каждого изделия (включая амортизацию!)
                const productIds = [...new Set(drafts.map(d => d.product_id))];
                const prodInfoRes = await client.query(`
                    SELECT i.id, i.mold_id, i.amortization_per_cycle as manual_amort,
                           (e.purchase_cost / NULLIF(e.planned_cycles, 0)) as mold_amort
                    FROM items i LEFT JOIN equipment e ON i.mold_id = e.id
                    WHERE i.id = ANY($1::int[])
                `, [productIds]);

                // 6. Станок (один запрос — перед циклом)
                const machineInfoRes = await client.query(`
                    SELECT id, (purchase_cost / NULLIF(planned_cycles, 0)) as machine_amort
                    FROM equipment WHERE equipment_type = 'machine' AND status = 'active' ORDER BY id ASC LIMIT 1
                `);
                const machineId = machineInfoRes.rows.length > 0 ? machineInfoRes.rows[0].id : null;
                const machineAmortRate = machineInfoRes.rows.length > 0 ? Number(new Big(machineInfoRes.rows[0].machine_amort || 0).round(4)) : 0;

                // 7. Обработка каждого черновика
                const totalVolumeBig = drafts.reduce((sum, d) => sum.plus(new Big(d.planned_quantity || 0)), new Big(0));
                let totalShiftCycles = 0;

                for (let batch of drafts) {
                    const bQtyBig = new Big(batch.planned_quantity || 0);
                    const bQty = Number(bQtyBig);
                    const bCycles = Number(new Big(batch.cycles_count || 0));
                    const fraction = totalVolumeBig.gt(0) ? bQtyBig.div(totalVolumeBig) : new Big(0);

                    // 7a. Списание сырья
                    let matCost = new Big(0);
                    for (let mat of cleanMaterials) {
                        const price = itemPrices.find(p => p.id == mat.id)?.current_price || 0;
                        const qty = new Big(mat.qty).times(fraction);
                        if (qty.gt(0)) {
                            matCost = matCost.plus(qty.times(price));
                            await client.query(`
                                INSERT INTO inventory_movements 
                                (item_id, quantity, movement_type, description, warehouse_id, batch_id, unit_price, movement_date) 
                                VALUES ($1, $2, 'production_expense', $3, $4, $5, $6, $7)
                            `, [mat.id, qty.times(-1).toFixed(4), `Замес: Партия ${batch.batch_number}`, materialsWh, batch.id, price, date]);
                        }
                    }

                    // 7b. Приход продукции на сушилку
                    await client.query(
                        `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, movement_date) 
                         VALUES ($1, $2, 'production_receipt', $3, $4, $5, $6)`,
                        [batch.product_id, bQty.toFixed(4), `Выпуск: Партия ${batch.batch_number}`, dryingWh, batch.id, date]
                    );

                    // 7d. ОБНОВЛЯЕМ ПАРТИЮ (Только мат. затраты, накладные теперь в глобальном дашборде)
                    await client.query(`
                        UPDATE production_batches 
                        SET mat_cost_total = $1, overhead_cost_total = 0, 
                            machine_amort_cost = 0, mold_amort_cost = 0 
                        WHERE id = $2
                    `, [matCost.toFixed(2), batch.id]);

                    const pInfo = prodInfoRes.rows.find(info => info.id == batch.product_id);
                    if (pInfo?.mold_id && bCycles > 0) {
                        await client.query(
                            `UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 WHERE id = $2`,
                            [bCycles, pInfo.mold_id]
                        );
                    }

                    totalShiftCycles += bCycles;
                }

                // 8. Износ станка и поддонов (суммарно за смену)
                if (totalShiftCycles > 0) {
                    if (machineId) {
                        await client.query(
                            `UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 WHERE id = $2`,
                            [totalShiftCycles, machineId]
                        );
                    }
                    await client.query(`
                        UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 
                        WHERE equipment_type = 'pallets' AND status = 'active'
                    `, [totalShiftCycles]);
                }

                // 9. Переводим все черновики в статус in_drying
                await client.query(
                    `UPDATE production_batches SET status = 'in_drying' WHERE status = 'draft' AND production_date = $1`,
                    [date]
                );
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: 'Смена зафиксирована! Сырье списано, продукция на сушилке.' });
        } catch (err) {
            console.error('FIXATE ERROR:', err);
            const isStockErr = err.message === 'insufficient_stock';
            if (isStockErr && Array.isArray(err.details)) {
                const lines = err.details.map(d => `• ${d.name}: нужно ${d.required}, в наличии ${d.available} (не хватает ${d.shortage})`);
                res.status(400).json({
                    error: 'Недостаточно сырья на складе',
                    details: lines.join('\n')
                });
            } else {
                res.status(500).json({ error: err.message });
            }
        }
    });

    // ------------------------------------------------------------------
    // ЗАДАЧА №8 (ПОЛНАЯ ВЕРСИЯ): УДАЛЕНИЕ С ОТКАТОМ ИЗНОСА И ВАЛИДАЦИЕЙ ID
    // ------------------------------------------------------------------
    router.delete('/api/production/batch/:id', requireAdmin, async (req, res) => {
        const batchId = parseInt(req.params.id);

        if (isNaN(batchId)) {
            return res.status(400).json({ error: `Неверный формат ID: ${req.params.id}` });
        }

        try {
            await withTransaction(pool, async (client) => {
                // 1. Читаем данные партии
                const batchRes = await client.query(`
                    SELECT 
                        product_id, cycles_count, status, is_salary_calculated,
                        to_char(production_date::date, 'YYYY-MM') as month_str,
                        to_char(production_date::date, 'YYYY-MM-DD') as prod_date
                    FROM production_batches 
                    WHERE id = $1
                `, [batchId]);
                
                if (batchRes.rows.length === 0) throw new Error('Партия не найдена');
                const batch = batchRes.rows[0];

                // ⛔ ПРОВЕРКА: Закрыт ли месяц?
                if (batch.is_salary_calculated) {
                    const monthCheck = await client.query('SELECT 1 FROM closed_periods WHERE period_str = $1', [batch.month_str]);
                    if (monthCheck.rows.length > 0) {
                        throw new Error(`⛔ Удаление заблокировано: месяц (${batch.month_str}) финансово закрыт. Расчеты трогать нельзя.`);
                    }
                }

                // 🛡️ ЗАЩИТА: Черновик — физическое удаление (Hard Delete)
                if (batch.status === 'draft') {
                    await client.query('DELETE FROM inventory_movements WHERE batch_id = $1', [batchId]);
                    await client.query('DELETE FROM production_batches WHERE id = $1', [batchId]);
                    return;
                }
                
                // 🛡️ ЗАЩИТА: Уже удалено
                if (batch.status === 'deleted') {
                    throw new Error('Эта партия уже была отменена и удалена. Двойное удаление заблокировано.');
                }
                const cycles = Number(new Big(batch.cycles_count || 0));

                // --- 2. СТАНДАРТНЫЙ ОТКАТ СКЛАДА И ОБОРУДОВАНИЯ ---
                await client.query('DELETE FROM inventory_movements WHERE batch_id = $1', [batchId]);
                
                const itemRes = await client.query('SELECT mold_id FROM items WHERE id = $1', [batch.product_id]);
                const moldId = itemRes.rows[0]?.mold_id;

                if (moldId && cycles > 0) {
                    await client.query(`UPDATE equipment SET current_cycles = GREATEST(0, COALESCE(current_cycles, 0) - $1) WHERE id = $2`, [cycles, moldId]);
                }
                if (cycles > 0) {
                    await client.query(`UPDATE equipment SET current_cycles = GREATEST(0, COALESCE(current_cycles, 0) - $1) WHERE equipment_type = 'machine' AND status = 'active'`, [cycles]);
                    await client.query(`UPDATE equipment SET current_cycles = GREATEST(0, COALESCE(current_cycles, 0) - $1) WHERE equipment_type = 'pallets' AND status = 'active'`, [cycles]);
                }

                // 3. УДАЛЯЕМ САМУ ПАРТИЮ ИЗ БАЗЫ
                await client.query(`UPDATE production_batches SET status = 'deleted' WHERE id = $1`, [batchId]);

                // 🔄 4. КАСКАДНЫЙ ПЕРЕСЧЕТ ЗАРПЛАТЫ
                if (batch.is_salary_calculated) {
                    const prodRes = await client.query(`
                        SELECT COALESCE(SUM(pb.actual_good_qty * COALESCE(i.piece_rate, 0)), 0) as total_fund
                        FROM production_batches pb
                        LEFT JOIN items i ON pb.product_id = i.id
                        WHERE pb.production_date = $1 AND pb.status = 'completed'
                    `, [batch.prod_date]);
                    let newTotalFundBig = new Big(prodRes.rows[0].total_fund || 0).round(0);
                    let newTotalFund = Number(newTotalFundBig);

                    const workersRes = await client.query(`SELECT employee_id, ktu FROM timesheet_records WHERE record_date = $1 AND status = 'present'`, [batch.prod_date]);
                    const workers = workersRes.rows;
                    let totalKtuBig = workers.reduce((sum, w) => sum.plus(new Big(w.ktu || 0)), new Big(0));
                    let totalKtu = Number(totalKtuBig);

                    if (newTotalFund === 0 || totalKtu === 0) {
                        // Если нет фонда ИЛИ нет рабочих с КТУ, принудительно обнуляем сделку всем за этот день
                        await client.query(`UPDATE timesheet_records SET bonus = 0 WHERE record_date = $1`, [batch.prod_date]);
                    } else if (totalKtuBig.gt(0)) {
                        let distributed = 0;
                        for (let i = 0; i < workers.length; i++) {
                            const ktuBig = new Big(workers[i].ktu || 0);
                            const workerBonusBig = newTotalFundBig.times(ktuBig).div(totalKtuBig).round(0);
                            workers[i].new_bonus = Number(workerBonusBig);
                            distributed += workers[i].new_bonus;
                        }
                        const diff = newTotalFund - distributed;
                        if (diff !== 0 && workers.length > 0) workers[0].new_bonus += diff;

                        for (let w of workers) {
                            await client.query(`UPDATE timesheet_records SET bonus = $1 WHERE employee_id = $2 AND record_date = $3`, [w.new_bonus, w.employee_id, batch.prod_date]);
                        }
                    }
                }
            });
            res.json({ success: true });
        } catch (err) {
            // 🚀 Изменили статус с 500 на 400, чтобы фронтенд понял, что это 
            // не сбой сервера, а логическая ошибка (сработал замок), и показал красивый текст
            res.status(400).json({ error: err.message });
        }
    });

    router.post('/api/recipes/save', requireAdmin, async (req, res) => {
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
                if (ingredients.length > 0) {
                    const matIds = ingredients.map(i => i.materialId);
                    const qtys = ingredients.map(i => i.qty);
                    await client.query(`
                        INSERT INTO recipes (product_id, material_id, quantity_per_unit)
                        SELECT $1, * FROM UNNEST($2::int[], $3::numeric[])
                    `, [productId, matIds, qtys]);
                }
            });
            res.json({ success: true });
        } catch (err) {
            // Если ошибка проверки (force), отдаем статус 400 чтобы фронт показал Confirm
            if (err.message.includes('ВНИМАНИЕ!')) {
                res.status(400).json({ warning: err.message });
            } else {
                console.error(err);
                res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
            }
        }
    });



    router.post('/api/recipes/sync-category', requireAdmin, async (req, res) => {
        const { targetProductIds, materials } = req.body;
        try {
            await withTransaction(pool, async (client) => {
                if (!targetProductIds || targetProductIds.length === 0) throw new Error('Не выбраны товары для синхронизации.');

                const productIds = [];
                const materialIds = [];
                const quantities = [];
                for (const targetId of targetProductIds) {
                    for (const mat of materials) {
                        productIds.push(targetId);
                        materialIds.push(mat.materialId);
                        quantities.push(mat.qty);
                    }
                }
                await client.query(`
                    INSERT INTO recipes (product_id, material_id, quantity_per_unit)
                    SELECT * FROM UNNEST($1::int[], $2::int[], $3::numeric[])
                    ON CONFLICT (product_id, material_id)
                    DO UPDATE SET quantity_per_unit = EXCLUDED.quantity_per_unit
                `, [productIds, materialIds, quantities]);
            });
            res.json({ success: true, message: `Успешно применено к ${targetProductIds.length} позициям.` });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // НОВЫЙ МАРШРУТ: СВОДНЫЙ ПЛАН И ОБЩИЙ ДЕФИЦИТ СЫРЬЯ (MRP)
    // ------------------------------------------------------------------
    router.get('/api/production/mrp-summary', async (req, res) => {
        try {
            // 🚀 Динамически получаем ID склада сырья
            const materialsWh = await getWhId(pool, 'materials');
            const filterProductId = req.query.product_id ? parseInt(req.query.product_id) : null;

            // 1. Собираем все невыполненные задачи
            const planParams = [];
            let planQuery = `
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
            `;
            if (filterProductId) {
                planParams.push(filterProductId);
                planQuery += ` AND pp.item_id = $1 `;
            }
            planQuery += ` GROUP BY pp.item_id, i.name, i.unit ORDER BY total_needed_qty DESC `;

            const planRes = await pool.query(planQuery, planParams);
            const productionPlan = planRes.rows;

            // 2. Рассчитываем потребность по рецептам и остатки одним мощным CTE запросом
            let deficitReport = [];
            
            if (productionPlan.length > 0) {
                const deficitParams = [materialsWh];
                let deficitQuery = `
                    WITH needed_materials AS (
                        SELECT r.material_id, SUM(r.quantity_per_unit * pp.total_needed_qty) as total_needed
                        FROM recipes r
                        JOIN (
                            SELECT pp.item_id, SUM(pp.quantity) as total_needed_qty
                            FROM planned_production pp
                            JOIN client_order_items coi ON pp.order_item_id = coi.id
                            JOIN client_orders co ON coi.order_id = co.id
                            WHERE co.status IN ('pending', 'processing')
                `;
                
                if (filterProductId) {
                    deficitParams.push(filterProductId);
                    deficitQuery += ` AND pp.item_id = $2 `;
                }

                deficitQuery += `
                            GROUP BY pp.item_id
                        ) pp ON r.product_id = pp.item_id
                        GROUP BY r.material_id
                    ),
                    material_stock AS (
                        SELECT m.item_id, COALESCE(SUM(m.quantity), 0) as balance
                        FROM inventory_movements m
                        WHERE m.warehouse_id = $1
                        GROUP BY m.item_id
                    )
                    SELECT i.name, i.unit, nm.total_needed, COALESCE(ms.balance, 0) as balance
                    FROM needed_materials nm
                    JOIN items i ON nm.material_id = i.id
                    LEFT JOIN material_stock ms ON ms.item_id = nm.material_id
                `;

                const deficitRes = await pool.query(deficitQuery, deficitParams);

                deficitReport = deficitRes.rows.map(row => {
                    const neededBig = new Big(row.total_needed || 0);
                    const balanceBig = new Big(row.balance || 0);
                    return {
                        name: row.name,
                        unit: row.unit,
                        needed: neededBig.toFixed(2),
                        stock: balanceBig.toFixed(2),
                        shortage: neededBig.gt(balanceBig) ? neededBig.minus(balanceBig).toFixed(2) : 0
                    };
                });
            }

            res.json({ success: true, productionPlan, deficitReport });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Получение списка дат, в которые были зафиксированные формовки
    router.get('/api/production/active-dates', async (req, res) => {
        try {
            const result = await pool.query(`
            SELECT DISTINCT to_char(production_date, 'YYYY-MM-DD') as date
            FROM production_batches
            WHERE status NOT IN ('draft', 'deleted')
            ORDER BY date DESC
        `);
            const dates = result.rows.map(r => r.date);
            res.json(dates);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // ГЛОБАЛЬНЫЙ ПОИСК ПАРТИЙ (OMNIBOX)
    // ------------------------------------------------------------------
    router.get('/api/production/search', async (req, res) => {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json([]);

        try {
            const searchPattern = `%${q}%`;
            const query = `
                SELECT 
                    b.id,
                    b.batch_number, 
                    b.planned_quantity,
                    b.product_id,
                    p.name as product_name,
                    p.unit,
                    b.mat_cost_total,
                    b.overhead_cost_total,
                    b.status,
                    b.shift_name,
                    to_char(b.production_date, 'YYYY-MM-DD') as production_date
                FROM production_batches b
                JOIN items p ON b.product_id = p.id
                WHERE b.status != 'deleted' AND (b.batch_number ILIKE $1 OR p.name ILIKE $1 OR b.shift_name ILIKE $1)
                ORDER BY b.created_at DESC
                LIMIT 50
            `;
            const result = await pool.query(query, [searchPattern]);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });



    return router;
};