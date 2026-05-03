// === ФАЙЛ: routes/production.js ===
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const Big = require('big.js');
const { auditLog } = require('../utils/db_init');

const { requireAdmin, authenticateToken } = require('../middleware/auth');
const { validateProductionDraft, validateRecipeSave, validateRecipeSync, validateRecipeBatch } = require('../middleware/validator');
const { isPackagingItem } = require('../utils/packagingMaterial');

// 👈 Добавили withTransaction
module.exports = function (pool, getWhId, withTransaction) {
    async function getRecipeLayerMap(client) {
        const res = await client.query(`SELECT value FROM settings WHERE key = 'recipe_layer_map'`);
        return res.rows.length ? (res.rows[0].value || {}) : {};
    }

    async function saveRecipeLayerMap(client, mapObj) {
        await client.query(
            `
            INSERT INTO settings (key, value) VALUES ('recipe_layer_map', $1)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `,
            [JSON.stringify(mapObj || {})]
        );
    }

    function normalizeLayer(layer) {
        return layer === 'face' || layer === 'main' || layer === 'packaging' ? layer : 'main';
    }

    async function getRecipeSplitMap(client) {
        const res = await client.query(`SELECT value FROM settings WHERE key = 'recipe_split_map'`);
        return res.rows.length ? (res.rows[0].value || {}) : {};
    }

    async function saveRecipeSplitMap(client, mapObj) {
        await client.query(
            `
            INSERT INTO settings (key, value) VALUES ('recipe_split_map', $1)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `,
            [JSON.stringify(mapObj || {})]
        );
    }

    /** Сборка строк рецепта в том же формате, что и GET /api/recipes/:productId */
    function assembleRecipeRowsForProduct(productId, resultRows, layerMap, splitMap) {
        const productIdStr = String(productId);
        const productLayerMap = layerMap[String(productIdStr)] || {};
        const productSplit = Array.isArray(splitMap[String(productIdStr)]) ? splitMap[String(productIdStr)] : [];

        if (productSplit.length > 0) {
            const infoByMat = new Map();
            resultRows.forEach((r) => infoByMat.set(Number(r.material_id), r));
            const splitRows = productSplit
                .map((entry, idx) => {
                    const materialId = Number(entry.materialId);
                    const info = infoByMat.get(materialId);
                    return {
                        id: null,
                        material_id: materialId,
                        quantity_per_unit: Number(entry.qty || 0),
                        material_name: info?.material_name || `Материал #${materialId}`,
                        unit: info?.unit || 'кг',
                        current_price: Number(info?.current_price || 0),
                        category: info?.category || null,
                        layer: normalizeLayer(entry.layer),
                        order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : idx
                    };
                })
                .filter((r) => r.quantity_per_unit > 0);
            splitRows.sort((a, b) => a.order - b.order);
            return splitRows;
        }

        return resultRows
            .map((row, idx) => ({
                ...row,
                layer: normalizeLayer(productLayerMap[String(row.material_id)] || 'main'),
                order: idx
            }))
            .sort(
                (a, b) =>
                    a.order - b.order || String(a.material_name || '').localeCompare(String(b.material_name || ''), 'ru')
            );
    }

    // --- ПРОСТЫЕ ЗАПРОСЫ ---
    router.get('/api/mix-templates', async (req, res) => {
        try {
            const result = await pool.query(`SELECT value FROM settings WHERE key = 'mix_templates'`);
            if (result.rows.length > 0) res.json(result.rows[0].value);
            else res.json({ big: [], small: [] });
        } catch (err) {
            logger.error(err);
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
            logger.error(err);
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
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Ошибка сохранения шаблона.' });
        }
    });

    // Batch-сохранение нескольких шаблонов за одну транзакцию
    router.post('/api/mix-templates/batch', requireAdmin, async (req, res) => {
        const { templates } = req.body;
        if (!Array.isArray(templates) || templates.length === 0) {
            return res.status(400).json({ error: 'templates[] required' });
        }
        for (const t of templates) {
            if (!t.templateKey || !Array.isArray(t.ingredients)) {
                return res.status(400).json({ error: 'Each template requires templateKey and ingredients[]' });
            }
        }
        try {
            await withTransaction(pool, async (client) => {
                // Читаем оба JSONB-ключа атомарно (FOR UPDATE)
                const resMix = await client.query(`SELECT value FROM settings WHERE key = 'mix_templates' FOR UPDATE`);
                let mixTemplates = resMix.rows.length > 0 ? resMix.rows[0].value : {};

                const resYields = await client.query(`SELECT value FROM settings WHERE key = 'mix_template_yields' FOR UPDATE`);
                let mixYields = resYields.rows.length > 0 ? resYields.rows[0].value : {};

                // Обновляем все ключи в памяти
                for (const t of templates) {
                    mixTemplates[t.templateKey] = t.ingredients;
                    mixYields[t.templateKey] = parseFloat(t.yieldValue) || 1;
                }

                // Записываем одним запросом
                await client.query(`
                    INSERT INTO settings (key, value) VALUES ('mix_templates', $1)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                `, [JSON.stringify(mixTemplates)]);

                await client.query(`
                    INSERT INTO settings (key, value) VALUES ('mix_template_yields', $1)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                `, [JSON.stringify(mixYields)]);
            });
            res.json({ success: true, count: templates.length });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка batch-сохранения шаблонов.' });
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' }); // Возвращает ОБЪЕКТ (причина ошибки .map)
        }
    });

    router.get('/api/production/batch/:id/materials', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT i.id, i.name, SUM(ABS(m.quantity)) as qty, i.unit, 
                       SUM(ABS(m.quantity) * CASE WHEN m.unit_price > 0 THEN m.unit_price ELSE i.current_price END) as cost,
                       (SELECT SUM(quantity) FROM inventory_movements sub WHERE sub.item_id = i.id AND sub.warehouse_id = m.warehouse_id AND sub.movement_type != 'production_draft') as current_stock,
                       CASE 
                           WHEN m.description LIKE '[ОСНОВНОЙ]%' THEN 'main' 
                           WHEN m.description LIKE '[ЛИЦЕВОЙ]%' THEN 'face' 
                           ELSE 'unknown' 
                       END as mix_type
                FROM inventory_movements m 
                JOIN items i ON m.item_id = i.id 
                WHERE m.batch_id = $1 
                  AND m.movement_type IN ('production_expense', 'production_draft')
                GROUP BY i.id, i.name, i.unit, m.warehouse_id,
                         CASE 
                           WHEN m.description LIKE '[ОСНОВНОЙ]%' THEN 'main' 
                           WHEN m.description LIKE '[ЛИЦЕВОЙ]%' THEN 'face' 
                           ELSE 'unknown' 
                         END
                ORDER BY mix_type DESC, cost DESC
            `, [req.params.id]);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/production/in-drying', async (req, res) => {
        try {
            const result = await pool.query(`SELECT pb.id, pb.batch_number, pb.product_id, i.name as product_name, pb.planned_quantity, pb.created_at FROM production_batches pb JOIN items i ON pb.product_id = i.id WHERE pb.status = 'in_drying' ORDER BY pb.created_at ASC`);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    /** Пакетная выдача рецептов (один запрос к БД вместо N× GET) — для UI сравнения рецептур */
    router.post('/api/recipes/batch', validateRecipeBatch, async (req, res) => {
        try {
            const rawIds = req.body.productIds || [];
            const productIds = [...new Set(rawIds.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0))];
            if (productIds.length === 0) {
                return res.status(400).json({ error: 'Некорректные productIds' });
            }

            const recipesRes = await pool.query(
                `
                SELECT r.product_id, r.id, r.material_id, r.quantity_per_unit,
                       i.name as material_name, i.unit, i.current_price, i.category
                FROM recipes r
                JOIN items i ON r.material_id = i.id
                WHERE r.product_id = ANY($1::int[])
                ORDER BY r.product_id, r.id
            `,
                [productIds]
            );

            const layersRes = await pool.query(`SELECT value FROM settings WHERE key = 'recipe_layer_map'`);
            const layerMap = layersRes.rows.length ? layersRes.rows[0].value || {} : {};
            const splitMap = await getRecipeSplitMap(pool);

            const grouped = new Map();
            productIds.forEach((id) => grouped.set(id, []));

            recipesRes.rows.forEach((row) => {
                const pid = parseInt(row.product_id, 10);
                if (grouped.has(pid)) grouped.get(pid).push(row);
            });

            const recipes = {};
            productIds.forEach((id) => {
                recipes[String(id)] = assembleRecipeRowsForProduct(id, grouped.get(id) || [], layerMap, splitMap);
            });

            res.json({ recipes });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/recipes/:productId', async (req, res) => {
        const productId = parseInt(req.params.productId, 10);
        if (!Number.isFinite(productId) || productId <= 0) {
            return res.status(400).json({ error: 'Некорректный productId' });
        }
        try {
            const result = await pool.query(`SELECT r.id, r.material_id, r.quantity_per_unit, i.name as material_name, i.unit, i.current_price, i.category FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1`, [productId]);
            const layersRes = await pool.query(`SELECT value FROM settings WHERE key = 'recipe_layer_map'`);
            const layerMap = layersRes.rows.length ? (layersRes.rows[0].value || {}) : {};
            const splitMap = await getRecipeSplitMap(pool);
            const rows = assembleRecipeRowsForProduct(productId, result.rows, layerMap, splitMap);
            res.json(rows);
        } catch (err) {
            logger.error(err);
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
            logger.error(err);
            res.status(500).send('Внутренняя ошибка сервера. Обратитесь к администратору.');
        }
    });


    // --- ТРАНЗАКЦИОННЫЕ МАРШРУТЫ (БЕЗОПАСНЫЕ) ---
    router.post('/api/production', requireAdmin, validateProductionDraft, async (req, res) => {
        let { date, shiftName, products, materialsUsed, status: requestedStatus } = req.body;
        const isDraft = (requestedStatus === 'draft');
        logger.info(`[PRODUCTION] Получен запрос: date=${date}, isDraft=${isDraft}`);

        try {
            await withTransaction(pool, async (client) => {
                // 🛡️ AUDIT-018: проверки date и products перенесены в validateProductionDraft middleware

                const materialsWh = await getWhId(client, 'materials');
                const dryingWh = await getWhId(client, 'drying');

                // Очистка списка материалов
                if (materialsUsed) {
                    materialsUsed = materialsUsed.filter(m => m.id && String(m.id).trim() !== '' && !isNaN(m.id));
                }
                // Упаковка — только план/отображение; физически не списываем при замесе (черновик/фиксация)
                if (materialsUsed && materialsUsed.length > 0) {
                    const pids = materialsUsed.map(m => parseInt(m.id, 10)).filter(n => !isNaN(n));
                    if (pids.length > 0) {
                        const infoRes = await client.query('SELECT id, name, category FROM items WHERE id = ANY($1::int[])', [pids]);
                        materialsUsed = materialsUsed.filter(m => {
                            const info = infoRes.rows.find(x => x.id === parseInt(m.id, 10));
                            return !isPackagingItem(info && info.name, info && info.category);
                        });
                    }
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
                                const mixPrefix = mat.mixType === 'main' ? '[ОСНОВНОЙ] ' : mat.mixType === 'face' ? '[ЛИЦЕВОЙ] ' : '';

                                await client.query(`
                                    INSERT INTO inventory_movements 
                                    (item_id, quantity, movement_type, description, warehouse_id, batch_id, unit_price, movement_date) 
                                    VALUES ($1, $2, 'production_draft', $3, $4, $5, $6, $7)
                                `, [mat.id, new Big(mat.qty).times(-1).toFixed(4), `${mixPrefix}Черновик состава: ${mat.name || 'Сырье'}`, materialsWh, newBatchId, price, date]);
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
            if (io) {
                io.emit('inventory_updated');
                io.emit('production_updated');
            }
            res.json({ success: true, message: isDraft ? 'Черновик сохранён' : 'Смена успешно зафиксирована' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });



    // ------------------------------------------------------------------
    // ФИКСАЦИЯ СМЕНЫ: Превращает все черновики (draft) за дату в полноценные партии
    // ------------------------------------------------------------------
    router.post('/api/production/fixate-shift', requireAdmin, async (req, res) => {
        const { date } = req.body;

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
                const draftIds = drafts.map(d => d.id);
                const materialsWh = await getWhId(client, 'materials');
                const dryingWh = await getWhId(client, 'drying');

                // 2. Проверяем, что у черновиков есть draft-движения сырья
                const draftMovesCheck = await client.query(
                    `SELECT DISTINCT item_id FROM inventory_movements 
                     WHERE batch_id = ANY($1::int[]) AND movement_type = 'production_draft'`, [draftIds]
                );
                if (draftMovesCheck.rows.length === 0) {
                    throw new Error('Ошибка: Список сырья пуст! У черновиков нет записей о материалах. Обновите страницу и попробуйте снова.');
                }

                // 3. Проверка остатков сырья (агрегируем потребность по draft-движениям)
                const draftNeedsRes = await client.query(`
                    SELECT item_id as id, SUM(ABS(quantity)) as total_needed
                    FROM inventory_movements
                    WHERE batch_id = ANY($1::int[]) AND movement_type = 'production_draft'
                    GROUP BY item_id
                `, [draftIds]);

                const matIds = draftNeedsRes.rows.map(r => Number(r.id));
                await client.query(`SELECT id FROM items WHERE id = ANY($1::int[]) FOR UPDATE`, [matIds]);

                const stockRes = await client.query(`
                    SELECT item_id as id, SUM(quantity) as total_qty
                    FROM inventory_movements
                    WHERE item_id = ANY($1::int[]) AND warehouse_id = $2
                      AND movement_type != 'production_draft'
                    GROUP BY item_id
                `, [matIds, materialsWh]);

                const namesRes = await client.query(`SELECT id, name FROM items WHERE id = ANY($1::int[])`, [matIds]);

                let insufficient = [];
                for (const need of draftNeedsRes.rows) {
                    const stockItem = stockRes.rows.find(s => s.id == need.id);
                    const nameObj = namesRes.rows.find(n => n.id == need.id);
                    const available = new Big(stockItem ? stockItem.total_qty : 0);
                    const required = new Big(need.total_needed || 0);
                    if (required.gt(available)) {
                        insufficient.push({
                            name: nameObj?.name || 'ID ' + need.id,
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

                // 4. Сбор WAC-цен на сырьё (средневзвешенная по закупкам за 180 дней)
                const itemPricesRes = await client.query(`
                    SELECT 
                        i.id,
                        COALESCE(
                            NULLIF(
                                ROUND(
                                    SUM(CASE WHEN m.movement_type = 'purchase' AND m.quantity > 0
                                                  AND COALESCE(m.movement_date, m.created_at) >= NOW() - INTERVAL '180 days'
                                             THEN COALESCE(m.amount, m.quantity * COALESCE(m.unit_price, 0))
                                        END)
                                    / NULLIF(
                                        SUM(CASE WHEN m.movement_type = 'purchase' AND m.quantity > 0
                                                      AND COALESCE(m.movement_date, m.created_at) >= NOW() - INTERVAL '180 days'
                                                 THEN m.quantity
                                            END), 0)::numeric
                                , 4),
                            0),
                            i.current_price
                        ) AS wac_price
                    FROM items i
                    LEFT JOIN inventory_movements m ON m.item_id = i.id AND m.movement_type = 'purchase'
                    WHERE i.id = ANY($1::int[])
                    GROUP BY i.id, i.current_price
                `, [matIds.length > 0 ? matIds : [0]]);

                const wacPrices = new Map();
                for (const row of itemPricesRes.rows) {
                    wacPrices.set(Number(row.id), Number(row.wac_price || 0));
                }

                // 5. Конвертация draft → expense: обновляем movement_type и unit_price
                for (const itemId of matIds) {
                    const wacPrice = wacPrices.get(itemId) || 0;
                    await client.query(`
                        UPDATE inventory_movements 
                        SET movement_type = 'production_expense',
                            unit_price = $1
                        WHERE batch_id = ANY($2::int[]) 
                          AND item_id = $3 
                          AND movement_type = 'production_draft'
                    `, [wacPrice, draftIds, itemId]);
                }

                // 6. Получаем информацию о формах для каждого изделия (амортизация)
                const productIds = [...new Set(drafts.map(d => d.product_id))];
                const prodInfoRes = await client.query(`
                    SELECT i.id, i.mold_id, i.amortization_per_cycle as manual_amort,
                           (e.purchase_cost / NULLIF(e.planned_cycles, 0)) as mold_amort
                    FROM items i LEFT JOIN equipment e ON i.mold_id = e.id
                    WHERE i.id = ANY($1::int[])
                `, [productIds]);

                // 7. Станок (один запрос — перед циклом)
                const machineInfoRes = await client.query(`
                    SELECT id, (purchase_cost / NULLIF(planned_cycles, 0)) as machine_amort
                    FROM equipment WHERE equipment_type = 'machine' AND status = 'active' ORDER BY id ASC LIMIT 1
                `);
                const machineId = machineInfoRes.rows.length > 0 ? machineInfoRes.rows[0].id : null;
                const machineAmortRate = machineInfoRes.rows.length > 0 ? Number(new Big(machineInfoRes.rows[0].machine_amort || 0).round(4)) : 0;

                // 8. Обработка каждой партии
                let totalShiftCycles = 0;

                for (let batch of drafts) {
                    const bQty = Number(new Big(batch.planned_quantity || 0));
                    const bCycles = Number(new Big(batch.cycles_count || 0));

                    // 8a. Расчёт mat_cost_total из уже обновлённых движений
                    const matCostRes = await client.query(`
                        SELECT COALESCE(SUM(ABS(quantity) * COALESCE(unit_price, 0)), 0) as mat_cost
                        FROM inventory_movements
                        WHERE batch_id = $1 AND movement_type = 'production_expense'
                    `, [batch.id]);
                    const matCost = Number(new Big(matCostRes.rows[0]?.mat_cost || 0).round(2));

                    // 8b. Приход продукции на сушилку
                    await client.query(
                        `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, movement_date) 
                         VALUES ($1, $2, 'production_receipt', $3, $4, $5, $6)`,
                        [batch.product_id, bQty.toFixed(4), `Выпуск: Партия ${batch.batch_number}`, dryingWh, batch.id, date]
                    );

                    // 8c. Расчёт амортизации (станок + форма)
                    const pInfo = prodInfoRes.rows.find(info => info.id == batch.product_id);
                    const pMoldAmort = Number(new Big(pInfo?.mold_amort || pInfo?.manual_amort || 0).round(4));
                    const calcMachineCost = Number(new Big(machineAmortRate).times(bCycles).round(2));
                    const calcMoldCost = Number(new Big(pMoldAmort).times(bCycles).round(2));

                    // 8d. Обновляем партию (мат. затраты + амортизация)
                    await client.query(`
                        UPDATE production_batches 
                        SET mat_cost_total = $1, overhead_cost_total = 0, 
                            machine_amort_cost = $3, mold_amort_cost = $4 
                        WHERE id = $2
                    `, [matCost, batch.id, calcMachineCost, calcMoldCost]);

                    if (pInfo?.mold_id && bCycles > 0) {
                        await client.query(
                            `UPDATE equipment SET current_cycles = COALESCE(current_cycles, 0) + $1 WHERE id = $2`,
                            [bCycles, pInfo.mold_id]
                        );
                    }

                    totalShiftCycles += bCycles;
                }

                // 9. Износ станка и поддонов (суммарно за смену)
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

                // 10. Переводим все черновики в статус in_drying
                await client.query(
                    `UPDATE production_batches SET status = 'in_drying' WHERE status = 'draft' AND production_date = $1`,
                    [date]
                );
            });

            const io = req.app.get('io');
            if (io) {
                io.emit('inventory_updated');
                io.emit('production_updated');
            }
            res.json({ success: true, message: 'Смена зафиксирована! Сырье списано, продукция на сушилке.' });
        } catch (err) {
            logger.error('FIXATE ERROR:', err);
            const isStockErr = err.message === 'insufficient_stock';
            if (isStockErr && Array.isArray(err.details)) {
                const lines = err.details.map(d => `• ${d.name}: нужно ${d.required}, в наличии ${d.available} (не хватает ${d.shortage})`);
                res.status(400).json({
                    error: 'Недостаточно сырья на складе',
                    details: lines.join('\n')
                });
            } else {
                logger.error(err);
                res.status(500).json({ error: 'Внутренняя ошибка сервера' });
            }
        }
    });

    // ------------------------------------------------------------------
    // ЗАДАЧА №8 (ПОЛНАЯ ВЕРСИЯ): УДАЛЕНИЕ С ОТКАТОМ ИЗНОСА И ВАЛИДАЦИЕЙ ID
    // ------------------------------------------------------------------
    router.delete('/api/production/batch/:id', requireAdmin, async (req, res) => {
        const batchId = parseInt(req.params.id);
        const reason = String((req.query || {}).reason || '').trim();

        if (isNaN(batchId)) {
            return res.status(400).json({ error: `Неверный формат ID: ${req.params.id}` });
        }
        if (!reason) {
            return res.status(400).json({ error: 'Укажите причину отмены формовки' });
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
            await auditLog(pool, req, 'production_batch_delete', 'production_batch', batchId, `reason=${reason}`);
            res.json({ success: true });
        } catch (err) {
            // 🚀 Изменили статус с 500 на 400, чтобы фронтенд понял, что это 
            // не сбой сервера, а логическая ошибка (сработал замок), и показал красивый текст
            res.status(400).json({ error: err.message });
        }
    });

    router.post('/api/recipes/save', requireAdmin, validateRecipeSave, async (req, res) => {
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
                    const agg = new Map();
                    const splitRows = [];
                    ingredients.forEach((ing, idx) => {
                        const matId = Number(ing.materialId);
                        const qty = Number(ing.qty || 0);
                        if (!Number.isFinite(matId) || matId <= 0 || !Number.isFinite(qty) || qty <= 0) return;
                        agg.set(matId, Number(agg.get(matId) || 0) + qty);
                        splitRows.push({
                            materialId: matId,
                            qty,
                            layer: normalizeLayer(ing.layer),
                            order: Number.isFinite(Number(ing.order)) ? Number(ing.order) : idx
                        });
                    });
                    const matIds = Array.from(agg.keys());
                    const qtys = matIds.map((id) => agg.get(id));
                    await client.query(`
                        INSERT INTO recipes (product_id, material_id, quantity_per_unit)
                        SELECT $1, * FROM UNNEST($2::int[], $3::numeric[])
                    `, [productId, matIds, qtys]);
                    const layerMap = await getRecipeLayerMap(client);
                    const splitMap = await getRecipeSplitMap(client);
                    const nextProductMap = {};
                    splitRows.forEach((row) => {
                        if (!nextProductMap[String(row.materialId)]) {
                            nextProductMap[String(row.materialId)] = row.layer;
                        }
                    });
                    layerMap[String(productId)] = nextProductMap;
                    splitMap[String(productId)] = splitRows.sort((a, b) => a.order - b.order);
                    await saveRecipeLayerMap(client, layerMap);
                    await saveRecipeSplitMap(client, splitMap);
                } else {
                    const layerMap = await getRecipeLayerMap(client);
                    const splitMap = await getRecipeSplitMap(client);
                    layerMap[String(productId)] = {};
                    splitMap[String(productId)] = [];
                    await saveRecipeLayerMap(client, layerMap);
                    await saveRecipeSplitMap(client, splitMap);
                }
            });
            res.json({ success: true });
        } catch (err) {
            // Если ошибка проверки (force), отдаем статус 400 чтобы фронт показал Confirm
            if (err.message.includes('ВНИМАНИЕ!')) {
                res.status(400).json({ warning: err.message });
            } else {
                logger.error(err);
                res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
            }
        }
    });



    /**
     * Синхронизация только указанных слоёв: убираем эти блоки из split target, добавляем из источника,
     * затем полностью пересобираем таблицу recipes по объединённому split (консистентно с сохранением).
     */
    async function applyRecipeSyncScopedLayers(client, targetId, materials, allowLayerSet, layerMap, splitMap) {
        const splitRowsIncoming = [];
        for (let idx = 0; idx < materials.length; idx++) {
            const mat = materials[idx];
            const layer = normalizeLayer(mat.layer);
            if (!allowLayerSet.has(layer)) continue;
            const matId = Number(mat.materialId);
            const qty = Number(mat.qty || 0);
            if (!Number.isFinite(matId) || matId <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
            splitRowsIncoming.push({
                materialId: matId,
                qty,
                layer,
                order: Number.isFinite(Number(mat.order)) ? Number(mat.order) : idx
            });
        }
        if (!splitRowsIncoming.length) throw new Error('Нет строк для синхронизации выбранных блоков');

        const sid = String(targetId);
        const prevSplitRaw = splitMap[sid];
        const existingSplitRows = Array.isArray(prevSplitRaw)
            ? prevSplitRaw.map((row) => ({
                  materialId: Number(row.materialId),
                  qty: Number(row.qty || 0),
                  layer: normalizeLayer(row.layer),
                  order: Number.isFinite(Number(row.order)) ? Number(row.order) : 0
              }))
            : [];
        const stripped = existingSplitRows.filter((row) => !allowLayerSet.has(normalizeLayer(row.layer)));

        const byKey = new Map();
        stripped.forEach((row, idx) => {
            const key = `${Number(row.materialId)}:${normalizeLayer(row.layer)}`;
            byKey.set(key, {
                materialId: Number(row.materialId),
                qty: Number(row.qty || 0),
                layer: normalizeLayer(row.layer),
                order: Number.isFinite(Number(row.order)) ? Number(row.order) : idx
            });
        });
        splitRowsIncoming.forEach((row, idx) => {
            const key = `${row.materialId}:${row.layer}`;
            byKey.set(key, {
                materialId: Number(row.materialId),
                qty: Number(row.qty || 0),
                layer: row.layer,
                order: Number.isFinite(Number(row.order)) ? Number(row.order) : 10000 + idx
            });
        });
        const mergedSplit = Array.from(byKey.values()).sort((a, b) => a.order - b.order);

        const agg = new Map();
        mergedSplit.forEach((row) => {
            const mid = Number(row.materialId);
            const q = Number(row.qty || 0);
            if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(q) || q <= 0) return;
            agg.set(mid, Number(agg.get(mid) || 0) + q);
        });

        await client.query('DELETE FROM recipes WHERE product_id = $1', [targetId]);
        if (agg.size > 0) {
            const materialIds = Array.from(agg.keys());
            const quantities = materialIds.map((id) => agg.get(id));
            const productIds = materialIds.map(() => Number(targetId));
            await client.query(
                `
                INSERT INTO recipes (product_id, material_id, quantity_per_unit)
                SELECT * FROM UNNEST($1::int[], $2::int[], $3::numeric[])
            `,
                [productIds, materialIds, quantities]
            );
        }

        const nextProductMap = {};
        mergedSplit.forEach((row) => {
            const k = String(row.materialId);
            if (!(k in nextProductMap)) nextProductMap[k] = normalizeLayer(row.layer);
        });
        layerMap[sid] = nextProductMap;
        splitMap[sid] = mergedSplit;
    }

    router.post('/api/recipes/sync-category', requireAdmin, validateRecipeSync, async (req, res) => {
        const { targetProductIds, materials, mode, layers } = req.body;
        try {
            await withTransaction(pool, async (client) => {
                // 🛡️ AUDIT-018: проверка targetProductIds перенесена в validateRecipeSync middleware

                const safeMode = mode === 'replace_all' ? 'replace_all' : 'upsert';
                const allowLayerSet =
                    Array.isArray(layers) && layers.length > 0
                        ? new Set(
                              layers.map((x) => String(x || '').toLowerCase()).filter((x) =>
                                  ['face', 'main', 'packaging'].includes(x)
                              )
                          )
                        : null;

                const layerMap = await getRecipeLayerMap(client);
                const splitMap = await getRecipeSplitMap(client);

                for (const targetId of targetProductIds) {
                    if (allowLayerSet && allowLayerSet.size > 0) {
                        await applyRecipeSyncScopedLayers(client, targetId, materials, allowLayerSet, layerMap, splitMap);
                        continue;
                    }

                    if (safeMode === 'replace_all') {
                        await client.query('DELETE FROM recipes WHERE product_id = $1', [targetId]);
                    }

                    const agg = new Map();
                    const splitRowsIncoming = [];
                    for (let idx = 0; idx < materials.length; idx++) {
                        const mat = materials[idx];
                        const matId = Number(mat.materialId);
                        const qty = Number(mat.qty || 0);
                        if (!Number.isFinite(matId) || matId <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
                        agg.set(matId, Number(agg.get(matId) || 0) + qty);
                        splitRowsIncoming.push({
                            materialId: matId,
                            qty,
                            layer: normalizeLayer(mat.layer),
                            order: Number.isFinite(Number(mat.order)) ? Number(mat.order) : idx
                        });
                    }

                    if (agg.size > 0) {
                        const materialIds = Array.from(agg.keys());
                        const quantities = materialIds.map((id) => agg.get(id));
                        const productIds = materialIds.map(() => Number(targetId));
                        await client.query(
                            `
                            INSERT INTO recipes (product_id, material_id, quantity_per_unit)
                            SELECT * FROM UNNEST($1::int[], $2::int[], $3::numeric[])
                            ON CONFLICT (product_id, material_id)
                            DO UPDATE SET quantity_per_unit = EXCLUDED.quantity_per_unit
                        `,
                            [productIds, materialIds, quantities]
                        );
                    }

                    const existingProductMap = safeMode === 'replace_all' ? {} : layerMap[String(targetId)] || {};
                    splitRowsIncoming.forEach((mat) => {
                        existingProductMap[String(mat.materialId)] = mat.layer;
                    });
                    layerMap[String(targetId)] = existingProductMap;

                    let existingSplitRows = safeMode === 'replace_all' ? [] : Array.isArray(splitMap[String(targetId)]) ? splitMap[String(targetId)] : [];
                    if (safeMode === 'replace_all') {
                        existingSplitRows = splitRowsIncoming.sort((a, b) => a.order - b.order);
                    } else {
                        const byKey = new Map();
                        existingSplitRows.forEach((row, idx) => {
                            const key = `${row.materialId}:${normalizeLayer(row.layer)}`;
                            byKey.set(key, {
                                materialId: Number(row.materialId),
                                qty: Number(row.qty || 0),
                                layer: normalizeLayer(row.layer),
                                order: Number.isFinite(Number(row.order)) ? Number(row.order) : idx
                            });
                        });
                        splitRowsIncoming.forEach((row) => {
                            const key = `${row.materialId}:${normalizeLayer(row.layer)}`;
                            byKey.set(key, {
                                materialId: Number(row.materialId),
                                qty: Number(row.qty || 0),
                                layer: normalizeLayer(row.layer),
                                order: Number.isFinite(Number(row.order)) ? Number(row.order) : byKey.size
                            });
                        });
                        existingSplitRows = Array.from(byKey.values()).sort((a, b) => a.order - b.order);
                    }
                    splitMap[String(targetId)] = existingSplitRows;
                }
                await saveRecipeLayerMap(client, layerMap);
                await saveRecipeSplitMap(client, splitMap);
            });
            res.json({ success: true, message: `Успешно применено к ${targetProductIds.length} позициям.` });
        } catch (err) {
            logger.error(err);
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
            logger.error(err);
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
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });


    // ------------------------------------------------------------------
    // АНАЛИТИКА ОТКЛОНЕНИЙ ПО ПАРТИИ (Plan vs Fact & Scrap Valuation)
    // ------------------------------------------------------------------
    router.get('/api/production/analytics/batch-deviations/:batchId', async (req, res) => {
        const batchId = parseInt(req.params.batchId);
        if (!Number.isFinite(batchId) || batchId <= 0) return res.status(400).json({ error: 'Неверный ID партии' });

        try {
            // 1. Основная информация о партии
            const batchRes = await pool.query(`
                SELECT pb.id, pb.batch_number, pb.product_id, pb.planned_quantity,
                       pb.actual_good_qty, pb.mat_cost_total,
                       pb.machine_amort_cost, pb.mold_amort_cost,
                       pb.status, i.name as product_name, i.unit as product_unit
                FROM production_batches pb
                JOIN items i ON pb.product_id = i.id
                WHERE pb.id = $1
            `, [batchId]);

            if (!batchRes.rows.length) return res.status(404).json({ error: 'Партия не найдена' });
            const batch = batchRes.rows[0];
            if (!batch.product_id) return res.json({ error: 'Нет product_id', materials: [], totals: {} });

            // 2. Фактический выход по сортам (из inventory_movements)
            const outputRes = await pool.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN movement_type IN ('finished_receipt','reserve_receipt')
                                      AND quantity > 0 THEN quantity END), 0) AS grade1,
                    COALESCE(SUM(CASE WHEN movement_type = 'markdown_receipt'
                                      AND quantity > 0 THEN quantity END), 0) AS grade2,
                    COALESCE(SUM(CASE WHEN movement_type = 'scrap_receipt'
                                      AND quantity > 0 THEN quantity END), 0) AS scrap
                FROM inventory_movements
                WHERE batch_id = $1
            `, [batchId]);
            const output = outputRes.rows[0];

            // 3. Фактический расход сырья (по материалам)
            const factRes = await pool.query(`
                SELECT m.item_id, i.name, i.unit,
                       SUM(ABS(m.quantity)) AS fact_qty,
                       SUM(ABS(m.quantity) * COALESCE(NULLIF(m.unit_price, 0), i.current_price, 0)) AS fact_cost
                FROM inventory_movements m
                JOIN items i ON m.item_id = i.id
                WHERE m.batch_id = $1 AND m.movement_type = 'production_expense'
                GROUP BY m.item_id, i.name, i.unit
            `, [batchId]);

            // 4. Плановый расход (рецепт)
            const recipeRes = await pool.query(`
                SELECT r.material_id, i.name, i.unit, i.current_price,
                       r.quantity_per_unit
                FROM recipes r
                JOIN items i ON r.material_id = i.id
                WHERE r.product_id = $1
            `, [batch.product_id]);

            // 5. Собираем метрики по каждому материалу
            const goodQty = Number(batch.actual_good_qty || 0);
            const scrapTotal = Number(output.scrap || 0);
            const recipeMap = new Map(recipeRes.rows.map(r => [Number(r.material_id), r]));
            const factMap = new Map(factRes.rows.map(r => [Number(r.item_id), r]));
            const allIds = new Set([...recipeMap.keys(), ...factMap.keys()]);

            const materials = [];
            for (const matId of allIds) {
                const recipe = recipeMap.get(matId);
                const fact = factMap.get(matId);

                const factQty = Number(fact?.fact_qty || 0);
                const factCost = Number(fact?.fact_cost || 0);
                const unitPrice = factQty > 0 ? factCost / factQty : Number(recipe?.current_price || 0);
                const qtyPerUnit = Number(recipe?.quantity_per_unit || 0);

                // План = рецепт × фактический годный выход 1 сорта
                const planGoodQty = qtyPerUnit * goodQty;
                // Расход на брак = рецепт × количество брака
                const scrapQty = qtyPerUnit * scrapTotal;
                // Неучтённые потери = факт - план_на_годные - план_на_брак
                const unaccountedQty = Math.max(0, factQty - planGoodQty - scrapQty);

                materials.push({
                    item_id: matId,
                    name: fact?.name || recipe?.name || `#${matId}`,
                    unit: fact?.unit || recipe?.unit || 'ед.',
                    fact_qty: Number(new Big(factQty).round(4)),
                    plan_good_qty: Number(new Big(planGoodQty).round(4)),
                    scrap_qty: Number(new Big(scrapQty).round(4)),
                    unaccounted_loss_qty: Number(new Big(unaccountedQty).round(4)),
                    unit_price: Number(new Big(unitPrice).round(4)),
                    fact_cost: Number(new Big(factCost).round(2)),
                    plan_good_cost: Number(new Big(planGoodQty).times(unitPrice).round(2)),
                    scrap_loss_cost: Number(new Big(scrapQty).times(unitPrice).round(2)),
                    unaccounted_loss_cost: Number(new Big(unaccountedQty).times(unitPrice).round(2)),
                });
            }

            // 6. Итого
            const totalFactCost = materials.reduce((s, m) => s + m.fact_cost, 0);
            const totalPlanCost = materials.reduce((s, m) => s + m.plan_good_cost, 0);
            const totalScrapLoss = materials.reduce((s, m) => s + m.scrap_loss_cost, 0);
            const totalUnaccounted = materials.reduce((s, m) => s + m.unaccounted_loss_cost, 0);
            const plannedQty = Number(batch.planned_quantity || 0);

            res.json({
                batch: {
                    id: batch.id,
                    batch_number: batch.batch_number,
                    product_name: batch.product_name,
                    product_unit: batch.product_unit,
                    planned_quantity: plannedQty,
                    actual_good_qty: goodQty,
                    grade2_qty: Number(output.grade2 || 0),
                    scrap_qty: scrapTotal,
                    total_output: goodQty + Number(output.grade2 || 0) + scrapTotal,
                    yield_pct: plannedQty > 0 ? Number(new Big(goodQty).div(plannedQty).times(100).round(1)) : 0,
                },
                materials,
                totals: {
                    fact_cost: Number(new Big(totalFactCost).round(2)),
                    plan_good_cost: Number(new Big(totalPlanCost).round(2)),
                    scrap_loss_cost: Number(new Big(totalScrapLoss).round(2)),
                    unaccounted_loss_cost: Number(new Big(totalUnaccounted).round(2)),
                    total_deviation: Number(new Big(totalFactCost - totalPlanCost).round(2)),
                    amortization: Number(new Big(Number(batch.machine_amort_cost || 0)).plus(Number(batch.mold_amort_cost || 0)).round(2)),
                }
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // ГЛОБАЛЬНАЯ СВОДКА ПОТЕРЬ ЗА ПЕРИОД
    // ------------------------------------------------------------------
    router.get('/api/production/analytics/deviations-summary', async (req, res) => {
        try {
            const now = new Date();
            const startDate = req.query.startDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const endDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            const endDate = req.query.endDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${endDay}`;

            const result = await pool.query(`
                WITH batch_output AS (
                    SELECT m.batch_id,
                        COALESCE(SUM(CASE WHEN movement_type IN ('finished_receipt','reserve_receipt')
                                          AND quantity > 0 THEN quantity END), 0) AS grade1,
                        COALESCE(SUM(CASE WHEN movement_type = 'markdown_receipt'
                                          AND quantity > 0 THEN quantity END), 0) AS grade2,
                        COALESCE(SUM(CASE WHEN movement_type = 'scrap_receipt'
                                          AND quantity > 0 THEN quantity END), 0) AS scrap
                    FROM inventory_movements m
                    WHERE m.batch_id IS NOT NULL
                    GROUP BY m.batch_id
                ),
                batch_costs AS (
                    SELECT m.batch_id,
                           SUM(ABS(m.quantity) * COALESCE(NULLIF(m.unit_price, 0), i.current_price, 0)) AS fact_cost
                    FROM inventory_movements m
                    JOIN items i ON m.item_id = i.id
                    WHERE m.movement_type = 'production_expense' AND m.batch_id IS NOT NULL
                    GROUP BY m.batch_id
                )
                SELECT pb.id, pb.batch_number, pb.product_id, i.name AS product_name,
                    pb.planned_quantity,
                    COALESCE(pb.actual_good_qty, 0) AS actual_good_qty,
                    COALESCE(bo.grade2, 0) AS grade2_qty,
                    COALESCE(bo.scrap, 0) AS scrap_qty,
                    COALESCE(bc.fact_cost, 0) AS fact_cost,
                    COALESCE(pb.machine_amort_cost, 0) + COALESCE(pb.mold_amort_cost, 0) AS amort_cost,
                    CASE WHEN pb.planned_quantity > 0
                         THEN ROUND(COALESCE(pb.actual_good_qty, 0)::numeric / pb.planned_quantity * 100, 1)
                         ELSE 0 END AS yield_pct,
                    to_char(pb.production_date, 'YYYY-MM-DD') AS production_date
                FROM production_batches pb
                JOIN items i ON pb.product_id = i.id
                LEFT JOIN batch_output bo ON bo.batch_id = pb.id
                LEFT JOIN batch_costs bc ON bc.batch_id = pb.id
                WHERE pb.status = 'completed'
                  AND pb.production_date BETWEEN $1 AND $2
                ORDER BY pb.production_date DESC, pb.id DESC
            `, [startDate, endDate]);

            const batches = result.rows;
            let totalFactCost = 0, totalYieldSum = 0, yieldCount = 0;

            for (const b of batches) {
                b.fact_cost = Number(b.fact_cost || 0);
                b.amort_cost = Number(b.amort_cost || 0);
                b.yield_pct = Number(b.yield_pct || 0);
                b.actual_good_qty = Number(b.actual_good_qty || 0);
                b.scrap_qty = Number(b.scrap_qty || 0);
                b.planned_quantity = Number(b.planned_quantity || 0);
                totalFactCost += b.fact_cost;
                if (b.planned_quantity > 0) { totalYieldSum += b.yield_pct; yieldCount++; }
            }

            // Per-batch deviation needs recipes — compute unaccounted for each
            const productIds = [...new Set(batches.map(b => b.product_id))];
            let recipeMap = new Map();
            if (productIds.length > 0) {
                const recipeRes = await pool.query(`
                    SELECT product_id, SUM(quantity_per_unit * COALESCE(i.current_price, 0)) AS recipe_cost_per_unit
                    FROM recipes r JOIN items i ON r.material_id = i.id
                    WHERE r.product_id = ANY($1::int[])
                    GROUP BY product_id
                `, [productIds]);
                for (const r of recipeRes.rows) recipeMap.set(Number(r.product_id), Number(r.recipe_cost_per_unit || 0));
            }

            let totalScrapLoss = 0, totalUnaccounted = 0;
            for (const b of batches) {
                const recipeCostPerUnit = recipeMap.get(b.product_id) || 0;
                b.plan_good_cost = Number(new Big(recipeCostPerUnit).times(b.actual_good_qty).round(2));
                b.scrap_loss_cost = Number(new Big(recipeCostPerUnit).times(b.scrap_qty).round(2));
                b.unaccounted_loss_cost = Number(new Big(Math.max(0, b.fact_cost - b.plan_good_cost - b.scrap_loss_cost)).round(2));
                totalScrapLoss += b.scrap_loss_cost;
                totalUnaccounted += b.unaccounted_loss_cost;
            }

            res.json({
                period: { startDate, endDate },
                summary: {
                    batch_count: batches.length,
                    avg_yield_pct: yieldCount > 0 ? Number(new Big(totalYieldSum / yieldCount).round(1)) : 0,
                    total_fact_cost: Number(new Big(totalFactCost).round(2)),
                    total_scrap_loss: Number(new Big(totalScrapLoss).round(2)),
                    total_unaccounted_loss: Number(new Big(totalUnaccounted).round(2)),
                },
                batches: batches.map(b => ({
                    id: b.id,
                    batch_number: b.batch_number,
                    product_name: b.product_name,
                    production_date: b.production_date,
                    planned_quantity: b.planned_quantity,
                    actual_good_qty: b.actual_good_qty,
                    yield_pct: b.yield_pct,
                    scrap_qty: b.scrap_qty,
                    fact_cost: b.fact_cost,
                    scrap_loss_cost: b.scrap_loss_cost,
                    unaccounted_loss_cost: b.unaccounted_loss_cost,
                }))
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка расчёта сводки потерь' });
        }
    });

    return router;
};