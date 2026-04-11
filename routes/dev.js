const express = require('express');
const router = express.Router();

module.exports = function (pool, withTransaction, logger) {
    if (process.env.DEV_MODE !== 'true') return router;

    // Middleware для двойной защиты
    router.use((req, res, next) => {
        if (process.env.DEV_MODE !== 'true') return res.status(403).end();
        next();
    });

    // КОМАНДА А: Принудительный Unlock
    router.post('/unlock-order/:id', async (req, res) => {
        try {
            await withTransaction(pool, async (client) => {
                const resOrder = await client.query('UPDATE client_orders SET is_locked = false WHERE id = $1 RETURNING doc_number', [req.params.id]);
                if (resOrder.rows.length > 0) {
                    logger.info(`🚨 DEV_MODE: Отвязан (unlocked) заказ №${resOrder.rows[0].doc_number} (ID: ${req.params.id})`);
                }
            });
            res.json({ success: true, message: 'Заказ успешно разблокирован' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    // КОМАНДА Б: Тотальное удаление транзакции
    router.delete('/transactions/:id', async (req, res) => {
        try {
            await withTransaction(pool, async (client) => {
                const txRes = await client.query('SELECT amount, transaction_type, linked_order_id, description FROM transactions WHERE id = $1', [req.params.id]);
                if (txRes.rows.length === 0) throw new Error("Транзакция не найдена");
                
                const tx = txRes.rows[0];

                // Откат оплат заказов
                if (tx.linked_order_id) {
                    const multiplier = (tx.transaction_type === 'income') ? -1 : 1;
                    await client.query('UPDATE client_orders SET paid_amount = GREATEST(0, paid_amount + $1) WHERE id = $2', [parseFloat(tx.amount) * multiplier, tx.linked_order_id]);
                }

                // Откат счетов
                if (tx.description) {
                    const match = String(tx.description).match(/(СЧ|ЗК)-(\d+)/i);
                    if (match) {
                        const docNum = match[0].toUpperCase();
                        await client.query(`UPDATE invoices SET status = 'pending' WHERE invoice_number = $1`, [docNum]);
                    }
                }

                await client.query('DELETE FROM transactions WHERE id = $1', [req.params.id]);
                logger.info(`🚨 DEV_MODE: Hard delete транзакции ID ${req.params.id}, сумма: ${tx.amount}`);
            });
            res.json({ success: true, message: 'Транзакция тотально удалена с откатами' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    // КОМАНДА В: Удаление партии производства
    router.delete('/production/:id', async (req, res) => {
        try {
            await withTransaction(pool, async (client) => {
                const batchId = req.params.id;
                const bRes = await client.query('SELECT batch_number, product_id, cycles_count, shift_name FROM production_batches WHERE id = $1', [batchId]);
                if (bRes.rows.length === 0) throw new Error('Партия не найдена');
                const batch = bRes.rows[0];

                // Вернуть сырье и удалить приход продукции
                await client.query('DELETE FROM inventory_movements WHERE batch_id = $1', [batchId]);

                // Вернуть циклы (матрица, станок, поддоны)
                if (batch.cycles_count > 0) {
                    const moldRes = await client.query('SELECT mold_id FROM items WHERE id = $1', [batch.product_id]);
                    const moldId = moldRes.rows[0]?.mold_id;
                    if (moldId) {
                        await client.query('UPDATE equipment SET current_cycles = GREATEST(0, COALESCE(current_cycles,0) - $1) WHERE id = $2', [batch.cycles_count, moldId]);
                    }
                    await client.query("UPDATE equipment SET current_cycles = GREATEST(0, COALESCE(current_cycles,0) - $1) WHERE equipment_type = 'machine' AND status = 'active'", [batch.cycles_count]);
                    await client.query("UPDATE equipment SET current_cycles = GREATEST(0, COALESCE(current_cycles,0) - $1) WHERE equipment_type = 'pallets' AND status = 'active'", [batch.cycles_count]);
                }

                // Удалить записи о начислении сдельной зарплаты за эту партию
                if (batch.batch_number) {
                    await client.query("DELETE FROM timesheet_records WHERE bonus_comment LIKE '%' || $1 || '%'", [batch.batch_number]);
                }

                await client.query('DELETE FROM production_batches WHERE id = $1', [batchId]);
                logger.info(`🚨 DEV_MODE: Hard delete партии ${batch.batch_number} (ID: ${batchId}) с полным откатом`);
            });
            res.json({ success: true, message: 'Партия тотально удалена с откатами' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    return router;
};