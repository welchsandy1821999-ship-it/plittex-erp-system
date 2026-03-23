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
    // ИНВЕНТАРИЗАЦИЯ: КОРРЕКТИРОВКА ОСТАТКОВ (ИСПРАВЛЕННЫЙ БЕЗОПАСНЫЙ МЕТОД)
    // ------------------------------------------------------------------
    router.post('/api/inventory/audit', async (req, res) => {
        const { warehouseId, adjustments } = req.body;
        const userId = req.user ? req.user.id : null;

        try {
            await withTransaction(pool, async (client) => {
                for (const adj of adjustments) {
                    const { itemId, batchId, actualQty } = adj;

                    // 1. Сначала блокируем строки (FOR UPDATE), чтобы никто не вставил новое движение
                    let lockQuery = `
                        SELECT id FROM inventory_movements 
                        WHERE item_id = $1 AND warehouse_id = $2
                    `;
                    const params = [itemId, warehouseId];
                    if (batchId) {
                        lockQuery += ` AND batch_id = $3`;
                        params.push(batchId);
                    } else {
                        lockQuery += ` AND batch_id IS NULL`;
                    }

                    // Выполняем блокировку существующих строк
                    await client.query(lockQuery + " FOR UPDATE", params);

                    // 2. Теперь спокойно считаем сумму (агрегат отдельно от FOR UPDATE)
                    let sumQuery = `
                        SELECT COALESCE(SUM(quantity), 0) as balance 
                        FROM inventory_movements 
                        WHERE item_id = $1 AND warehouse_id = $2
                    `;
                    if (batchId) sumQuery += ` AND batch_id = $3`;
                    else sumQuery += ` AND batch_id IS NULL`;

                    const stockRes = await client.query(sumQuery, params);
                    const currentBalance = parseFloat(stockRes.rows[0].balance);

                    // 3. Вычисляем дельту
                    const diffQty = actualQty - currentBalance;

                    // 4. Записываем корректировку, если есть разница
                    if (Math.abs(diffQty) > 0.0001) {
                        const desc = `Инвентаризация: факт ${actualQty}, было ${currentBalance}`;

                        await client.query(`
                            INSERT INTO inventory_movements 
                            (item_id, warehouse_id, batch_id, quantity, movement_type, description, user_id) 
                            VALUES ($1, $2, $3, $4, 'audit_adjustment', $5, $6)
                        `, [itemId, warehouseId, batchId, diffQty, desc, userId]);
                    }
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');

            res.json({ success: true, message: 'Инвентаризация завершена успешно' });
        } catch (err) {
            console.error('Ошибка инвентаризации:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 4. МАРШРУТ: РАСПАЛУБКА И ПРИЕМКА (POST /api/move-wip)
    // ------------------------------------------------------------------
    router.post('/api/move-wip', async (req, res) => {
        const { batchId, tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                // ✅ ТЕПЕРЬ ОНО ВНУТРИ, ТУТ client СУЩЕСТВУЕТ
                let userId = null;
                if (req.user && req.user.id) {
                    const userCheck = await client.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
                    if (userCheck.rows.length > 0) userId = req.user.id;
                }

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
    // 5. МАРШРУТ: БЕЗВОЗВРАТНАЯ УТИЛИЗАЦИЯ
    // ------------------------------------------------------------------
    router.post('/api/inventory/dispose', async (req, res) => {
        const { itemId, batchId, warehouseId, disposeQty, description } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                // ✅ ПЕРЕНЕСЛИ СЮДА. Теперь client определен.
                let userId = null;
                if (req.user && req.user.id) {
                    const userCheck = await client.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
                    if (userCheck.rows.length > 0) {
                        userId = req.user.id;
                    } else {
                        console.warn(`Предупреждение: Пользователь ${req.user.id} не найден.`);
                    }
                }

                // Само списание
                await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                VALUES ($1, $2, 'disposal_writeoff', $3, $4, $5, $6)
            `, [
                    itemId,
                    -Math.abs(disposeQty),
                    description || 'Безвозвратная утилизация (вывоз)',
                    warehouseId,
                    batchId || null,
                    userId // Передаем полученный выше ID или null
                ]);
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

    router.post('/api/inventory/purchase', async (req, res) => {
        const { itemId, quantity, pricePerUnit, supplierId, accountId } = req.body;

        // 🚀 ЗАДАЧА №11: Серверная валидация данных
        if (!itemId || !supplierId) {
            return res.status(400).json({ error: 'Не указан товар или поставщик!' });
        }

        const qtyNum = parseFloat(quantity);
        const priceNum = parseFloat(pricePerUnit);

        if (isNaN(qtyNum) || qtyNum <= 0) {
            return res.status(400).json({ error: 'Количество должно быть положительным числом!' });
        }
        if (isNaN(priceNum) || priceNum <= 0) {
            return res.status(400).json({ error: 'Цена за единицу должна быть больше нуля!' });
        }

        try {
            const materialsWh = await getWhId(pool, 'materials');

            await withTransaction(pool, async (client) => {
                const totalCostBig = new Big(quantity).times(pricePerUnit);
                const totalCost = totalCostBig.toFixed(2);

                if (accountId) {
                    const accRes = await client.query('SELECT balance FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
                    if (!accRes.rows[0]) throw new Error('Счет не найден');
                    if (new Big(accRes.rows[0].balance).lt(totalCostBig)) {
                        throw new Error(`Недостаточно средств. Нужно: ${totalCost} ₽`);
                    }
                }

                // 1. Оприходование на склад (Используем itemId вместо materialId)
                const moveRes = await client.query(`
                    INSERT INTO inventory_movements 
                    (item_id, quantity, movement_type, warehouse_id, supplier_id, amount, description)
                    VALUES ($1, $2, 'purchase', $3, $4, $5, $6) RETURNING id
                `, [itemId, quantity, materialsWh, supplierId, totalCost, `Закупка сырья (Цена: ${pricePerUnit})`]);

                // 2. Списание денег (Добавлен payment_method и source_module)
                if (accountId) {
                    await client.query(`
                        INSERT INTO transactions 
                        (account_id, amount, transaction_type, category, description, counterparty_id, payment_method, source_module)
                        VALUES ($1, $2, 'expense', 'Закупка сырья', $3, $4, $5, $6)
                    `, [accountId, totalCost, `Оплата закупки (движение склада #${moveRes.rows[0].id})`, supplierId, 'Безналичный расчет', 'purchase']);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};