// === ФАЙЛ: routes/inventory.js (Бэкенд-маршруты для модуля Склада) ===
// Комментарий: Этот файл принимает запросы от фронтенда (public/js/inventory.js) 
// и общается с базой данных PostgreSQL.

const express = require('express');
const router = express.Router();

// Комментарий: Оборачиваем роутер в функцию, чтобы пробросить в него pool (базу данных) 
// и общие функции (например, getWhId) из главного файла web.js.
module.exports = function (pool, getWhId) {

    // ------------------------------------------------------------------
    // 1. МАРШРУТ: ПОЛУЧЕНИЕ ОСТАТКОВ СКЛАДА (GET /api/inventory)
    // ------------------------------------------------------------------
    router.get('/api/inventory', async (req, res) => {
        const client = await pool.connect();
        try {
            const result = await client.query(`
                SELECT 
                    m.item_id, i.name as item_name, i.unit, 
                    m.warehouse_id, w.name as warehouse_name, 
                    
                    -- УМНАЯ ГРУППИРОВКА: Если это склад сырья, игнорируем партию (NULL), 
                    -- чтобы все плюсы и минусы цемента схлопнулись в одну красивую строку.
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
        } finally {
            client.release();
        }
    });

    // ------------------------------------------------------------------
    // 2. МАРШРУТ: СПИСАНИЕ В БРАК ИЛИ УТИЛЬ (POST /api/inventory/scrap)
    // Комментарий: Безопасно перемещает товар с текущего склада на склад брака
    // ------------------------------------------------------------------
    router.post('/api/inventory/scrap', async (req, res) => {
        const { itemId, batchId, warehouseId, targetWarehouseId, scrapQty, description } = req.body;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Запрашиваем ID склада брака динамически, чтобы избежать хардкода
            const defectWh = await getWhId(client, 'defect');

            // Списываем со старого склада (минус)
            await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
                VALUES ($1, $2, 'scrap_writeoff', $3, $4, $5)
            `, [itemId, -Math.abs(scrapQty), description, warehouseId, batchId || null]);

            // Приходуем на новый склад (плюс)
            const destType = parseInt(targetWarehouseId) === defectWh ? 'defect_receipt' : 'scrap_receipt';
            await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [itemId, Math.abs(scrapQty), destType, description, targetWarehouseId, batchId || null]);

            await client.query('COMMIT');
            res.json({ success: true, message: 'Успешно перемещено' });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Ошибка при списании:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // ------------------------------------------------------------------
    // 3. МАРШРУТ: ИНВЕНТАРИЗАЦИЯ (POST /api/inventory/audit)
    // Комментарий: Фиксирует ручные корректировки (плюс или минус)
    // ------------------------------------------------------------------
    router.post('/api/inventory/audit', async (req, res) => {
        const { warehouseId, adjustments } = req.body;
        const userId = req.user ? req.user.id : null;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            for (let adj of adjustments) {
                // Если дифференциал отрицательный (недостача) или положительный (излишек)
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                    VALUES ($1, $2, 'audit_adjustment', 'Инвентаризация (Корректировка)', $3, $4, $5)
                `, [adj.itemId, adj.diffQty, warehouseId, adj.batchId || null, userId]);
            }

            await client.query('COMMIT');
            res.json({ success: true, message: 'Инвентаризация сохранена' });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Ошибка инвентаризации:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // ------------------------------------------------------------------
    // 4. МАРШРУТ: РАСПАЛУБКА И ПРИЕМКА (POST /api/move-wip)
    // Комментарий: Списывает из сушилки и распределяет по складам (готовая, уценка, брак)
    // ------------------------------------------------------------------
    router.post('/api/move-wip', async (req, res) => {
        const { batchId, tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete } = req.body;
        const userId = req.user ? req.user.id : null;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const dryingWh = await getWhId(client, 'drying');
            const finishedWh = await getWhId(client, 'finished');
            const markdownWh = await getWhId(client, 'markdown'); // Склад уценки (№5)
            const defectWh = await getWhId(client, 'defect');     // Склад брака (№6)

            // Считаем сколько всего забираем из сушилки
            let totalRemoved = goodQty + grade2Qty + scrapQty;
            if (isComplete) {
                totalRemoved = currentWipQty; // Если закрываем полностью, списываем весь остаток
            }

            // 1. Списание из сушилки (WIP)
            await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                VALUES ($1, $2, 'wip_expense', 'Распалубка: Выход из сушилки', $3, $4, $5)
            `, [tileId, -totalRemoved, dryingWh, batchId, userId]);

            // 2. Приход Годной продукции (1 сорт)
            if (goodQty > 0) {
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                    VALUES ($1, $2, 'finished_receipt', 'Распалубка: 1-й сорт', $3, $4, $5)
                `, [tileId, goodQty, finishedWh, batchId, userId]);
            }

            // 3. Приход Уценки (2 сорт)
            if (grade2Qty > 0) {
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                    VALUES ($1, $2, 'markdown_receipt', 'Распалубка: 2-й сорт (Уценка)', $3, $4, $5)
                `, [tileId, grade2Qty, markdownWh, batchId, userId]);
            }

            // 4. Приход Брака (Бой)
            if (scrapQty > 0) {
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                    VALUES ($1, $2, 'scrap_receipt', 'Распалубка: Брак (Бой)', $3, $4, $5)
                `, [tileId, scrapQty, defectWh, batchId, userId]);
            }

            // 5. Если партия закрыта полностью, меняем статус
            if (isComplete && batchId) {
                await client.query(`UPDATE production_batches SET status = 'completed' WHERE id = $1`, [batchId]);
            }

            await client.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Ошибка распалубки:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // ------------------------------------------------------------------
    // 5. МАРШРУТ: БЕЗВОЗВРАТНАЯ УТИЛИЗАЦИЯ (POST /api/inventory/dispose)
    // Комментарий: Физическое списание со склада утиля в ноль (вывоз на свалку)
    // ------------------------------------------------------------------
    router.post('/api/inventory/dispose', async (req, res) => {
        // Утилизация обычно требует указания количества, которое мы списываем
        const { itemId, batchId, warehouseId, disposeQty, description } = req.body;
        const userId = req.user ? req.user.id : null;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Списываем товар окончательно (отрицательное количество)
            await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                VALUES ($1, $2, 'disposal_writeoff', $3, $4, $5, $6)
            `, [
                itemId,
                -Math.abs(disposeQty), // Гарантируем, что это будет минус
                description || 'Безвозвратная утилизация (вывоз)',
                warehouseId,
                batchId || null,
                userId
            ]);

            await client.query('COMMIT');
            res.json({ success: true, message: 'Успешно утилизировано' });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Ошибка утилизации:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // ------------------------------------------------------------------
    // 6. МАРШРУТ: ЗАКУПКА СЫРЬЯ (POST /api/purchase)
    // ------------------------------------------------------------------
    router.post('/api/purchase', async (req, res) => {
        const { materialId, quantity, pricePerUnit, supplier } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const materialsWh = await getWhId(client, 'materials');
            const desc = `Приход от поставщика: ${supplier || 'Не указан'}`;

            await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, created_at) VALUES ($1, $2, 'purchase_receipt', $3, $4, CURRENT_TIMESTAMP)`, [materialId, quantity, desc, materialsWh]);

            const totalCost = quantity * pricePerUnit;
            if (totalCost > 0) {
                await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method) VALUES ($1, 'expense', 'Закупка сырья', $2, 0, 'Безналичный расчет')`, [totalCost, desc]);
                if (pricePerUnit > 0) await client.query(`UPDATE items SET current_price = $1 WHERE id = $2`, [pricePerUnit, materialId]);
            }
            await client.query('COMMIT');
            res.json({ success: true, message: 'Сырье оприходовано' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });
    // Комментарий: Возвращаем настроенный роутер, чтобы web.js мог его использовать
    return router;
};