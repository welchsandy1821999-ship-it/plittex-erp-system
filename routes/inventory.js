// === ФАЙЛ: routes/inventory.js (Бэкенд-маршруты для модуля Склада) ===

const express = require('express');
const router = express.Router();
const Big = require('big.js');
const { sendNotify } = require('../utils/telegram');

// 👈 Добавили withTransaction третьим аргументом
module.exports = function (pool, getWhId, withTransaction) {

    // ------------------------------------------------------------------
    // 1. МАРШРУТ: ПОЛУЧЕНИЕ ОСТАТКОВ СКЛАДА (GET /api/inventory)
    // ------------------------------------------------------------------
    router.get('/api/inventory', async (req, res) => {
        try {
            // Для SELECT транзакция не нужна, pool.query сам берет и возвращает коннект
            const result = await pool.query(`
                SELECT 
                    m.item_id, i.name as item_name, i.unit, 
                    m.warehouse_id, w.name as warehouse_name, 
                    CASE WHEN w.type = 'materials' THEN NULL ELSE m.batch_id END as batch_id, 
                    CASE WHEN w.type = 'materials' THEN NULL ELSE b.batch_number END as batch_number, 
                    SUM(m.quantity) as total 
                FROM inventory_movements m
                JOIN items i ON m.item_id = i.id
                JOIN warehouses w ON m.warehouse_id = w.id
                LEFT JOIN production_batches b ON m.batch_id = b.id
                GROUP BY 
                    m.item_id, i.name, i.unit, 
                    m.warehouse_id, w.name, 
                    CASE WHEN w.type = 'materials' THEN NULL ELSE m.batch_id END, 
                    CASE WHEN w.type = 'materials' THEN NULL ELSE b.batch_number END
                HAVING SUM(m.quantity) <> 0 
                ORDER BY w.name, i.name
            `);
            res.json(result.rows);
        } catch (err) {
            console.error('Ошибка при получении остатков:', err);
            res.status(500).json({ error: 'Ошибка сервера при расчете остатков' });
        }
    });

    // ------------------------------------------------------------------
    // 2. МАРШРУТ: СПИСАНИЕ В БРАК ИЛИ УТИЛЬ (POST /api/inventory/scrap)
    // ------------------------------------------------------------------
    router.post('/api/inventory/scrap', async (req, res) => {
        const { itemId, batchId, warehouseId, targetWarehouseId, scrapQty, description } = req.body;

        try {
            // 👈 Используем безопасную транзакцию
            await withTransaction(pool, async (client) => {
                const defectWh = await getWhId(client, 'defect');

                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
                    VALUES ($1, $2, 'scrap_writeoff', $3, $4, $5)
                `, [itemId, -Math.abs(scrapQty), description, warehouseId, batchId || null]);

                const destType = parseInt(targetWarehouseId) === defectWh ? 'defect_receipt' : 'scrap_receipt';
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [itemId, Math.abs(scrapQty), destType, description, targetWarehouseId, batchId || null]);
            });
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`⚠️ <b>Списание в брак</b>\nКоличество: ${scrapQty}\nПричина: ${description || 'Не указана'}`);

            res.json({ success: true, message: 'Успешно перемещено' });
        } catch (err) {
            console.error('Ошибка при списании:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 3. МАРШРУТ: ИНВЕНТАРИЗАЦИЯ (POST /api/inventory/audit)
    // ------------------------------------------------------------------
    router.post('/api/inventory/audit', async (req, res) => {
        const { warehouseId, adjustments } = req.body;
        const userId = req.user ? req.user.id : null;

        try {
            await withTransaction(pool, async (client) => {
                for (let adj of adjustments) {
                    await client.query(`
                        INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                        VALUES ($1, $2, 'audit_adjustment', 'Инвентаризация (Корректировка)', $3, $4, $5)
                    `, [adj.itemId, adj.diffQty, warehouseId, adj.batchId || null, userId]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`📋 <b>Инвентаризация</b>\nПроведена ручная корректировка остатков на складе.`);

            res.json({ success: true, message: 'Инвентаризация сохранена' });
        } catch (err) {
            console.error('Ошибка инвентаризации:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 4. МАРШРУТ: РАСПАЛУБКА И ПРИЕМКА (POST /api/move-wip)
    // ------------------------------------------------------------------
    router.post('/api/move-wip', async (req, res) => {
        const { batchId, tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete } = req.body;
        const userId = req.user ? req.user.id : null;

        try {
            await withTransaction(pool, async (client) => {
                const dryingWh = await getWhId(client, 'drying');
                const finishedWh = await getWhId(client, 'finished');
                const markdownWh = await getWhId(client, 'markdown');
                const defectWh = await getWhId(client, 'defect');

                let totalRemoved = goodQty + grade2Qty + scrapQty;
                if (isComplete) totalRemoved = currentWipQty;

                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                    VALUES ($1, $2, 'wip_expense', 'Распалубка: Выход из сушилки', $3, $4, $5)
                `, [tileId, -totalRemoved, dryingWh, batchId, userId]);

                if (goodQty > 0) {
                    await client.query(`
                        INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                        VALUES ($1, $2, 'finished_receipt', 'Распалубка: 1-й сорт', $3, $4, $5)
                    `, [tileId, goodQty, finishedWh, batchId, userId]);
                }

                if (grade2Qty > 0) {
                    await client.query(`
                        INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                        VALUES ($1, $2, 'markdown_receipt', 'Распалубка: 2-й сорт (Уценка)', $3, $4, $5)
                    `, [tileId, grade2Qty, markdownWh, batchId, userId]);
                }

                if (scrapQty > 0) {
                    await client.query(`
                        INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                        VALUES ($1, $2, 'scrap_receipt', 'Распалубка: Брак (Бой)', $3, $4, $5)
                    `, [tileId, scrapQty, defectWh, batchId, userId]);
                }

                if (isComplete && batchId) {
                    await client.query(`UPDATE production_batches SET status = 'completed' WHERE id = $1`, [batchId]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            // Уведомление в ТГ можно не слать, если распалубка делается 100 раз на дню, но если нужно, раскомментируй строку ниже:
            // sendNotify(`📦 <b>Распалубка</b>\nПлитка переведена из сушилки на склад.`);

            res.json({ success: true });
        } catch (err) {
            console.error('Ошибка распалубки:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 5. МАРШРУТ: БЕЗВОЗВРАТНАЯ УТИЛИЗАЦИЯ (POST /api/inventory/dispose)
    // ------------------------------------------------------------------
    router.post('/api/inventory/dispose', async (req, res) => {
        const { itemId, batchId, warehouseId, disposeQty, description } = req.body;
        const userId = req.user ? req.user.id : null;

        try {
            await withTransaction(pool, async (client) => {
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                    VALUES ($1, $2, 'disposal_writeoff', $3, $4, $5, $6)
                `, [itemId, -Math.abs(disposeQty), description || 'Безвозвратная утилизация (вывоз)', warehouseId, batchId || null, userId]);
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`🗑️ <b>Утилизация (Вывоз)</b>\nСписано: ${disposeQty} ед.`);

            res.json({ success: true, message: 'Успешно утилизировано' });
        } catch (err) {
            console.error('Ошибка утилизации:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 6. МАРШРУТ: ЗАКУПКА СЫРЬЯ (POST /api/purchase)
    // ------------------------------------------------------------------
    router.post('/api/purchase', async (req, res) => {
        const { materialId, quantity, pricePerUnit, supplier, accountId } = req.body;

        if (!quantity || quantity <= 0 || pricePerUnit < 0) {
            return res.status(400).json({ error: 'Количество должно быть больше нуля, а цена не может быть отрицательной!' });
        }

        if (!accountId) {
            return res.status(400).json({ error: 'Необходим ID счета для оплаты!' });
        }

        try {
            await withTransaction(pool, async (client) => {
                const materialsWh = await getWhId(client, 'materials');
                const desc = `Приход от поставщика: ${supplier || 'Не указан'}`;

                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, created_at) 
                    VALUES ($1, $2, 'purchase_receipt', $3, $4, CURRENT_TIMESTAMP)
                `, [materialId, quantity, desc, materialsWh]);

                // 👈 Точная математика для денег!
                const totalCost = Big(quantity).times(pricePerUnit).toNumber();

                if (totalCost > 0) {
                    await client.query(`
                        INSERT INTO transactions (account_id, amount, transaction_type, category, description, vat_amount, payment_method) 
                        VALUES ($1, $2, 'expense', 'Закупка сырья', $3, 0, 'Безналичный расчет')
                    `, [accountId, totalCost, desc]);

                    if (pricePerUnit > 0) {
                        await client.query(`UPDATE items SET current_price = $1 WHERE id = $2`, [pricePerUnit, materialId]);
                    }
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`🚚 <b>Закупка сырья</b>\nПоставщик: ${supplier || 'Не указан'}\nПринято: ${quantity} ед.`);

            res.json({ success: true, message: 'Сырье оприходовано' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};