const express = require('express');
const router = express.Router();
const Big = require('big.js');
const { sendNotify } = require('../utils/telegram');

// 👈 Добавили withTransaction 4-м аргументом
module.exports = function (pool, getWhId, getNextDocNumber, withTransaction) {

    // ------------------------------------------------------------------
    // Взаимозачет с защитой от минусов
    // ------------------------------------------------------------------
    router.post('/api/sales/orders/offset', async (req, res) => {
        const { docNum, amount } = req.body;
        // 🛡️ ПАТЧ БЕЗОПАСНОСТИ:
        if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Сумма зачета должна быть больше нуля!' });

        try {
            await withTransaction(pool, async (client) => {
                const orderRes = await client.query('SELECT counterparty_id FROM client_orders WHERE doc_number = $1', [docNum]);
                if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                const cpId = orderRes.rows[0].counterparty_id;

                await client.query(`INSERT INTO transactions (account_id, counterparty_id, amount, transaction_type, category, description, payment_method) VALUES (1, $1, $2, 'expense', 'Взаимозачет', $3, 'Взаимозачет')`, [cpId, amount, `Взаимозачет: списание переплаты за заказ ${docNum}`]);
                await client.query(`INSERT INTO transactions (account_id, counterparty_id, amount, transaction_type, category, description, payment_method) VALUES (1, $1, $2, 'income', 'Взаимозачет', $3, 'Взаимозачет')`, [cpId, amount, `Оплата по заказу ${docNum} (взаимозачет аванса)`]);

                const invRes = await client.query(`SELECT id, amount FROM invoices WHERE invoice_number = $1 AND status = 'pending' ORDER BY created_at ASC`, [docNum]);
                let remainingAmount = amount;
                for (let inv of invRes.rows) {
                    if (remainingAmount <= 0) break;
                    if (remainingAmount >= inv.amount) {
                        await client.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [inv.id]);
                        remainingAmount -= inv.amount;
                    } else {
                        await client.query(`UPDATE invoices SET amount = amount - $1 WHERE id = $2`, [remainingAmount, inv.id]);
                        remainingAmount = 0;
                    }
                }
            });
            res.json({ success: true, message: 'Взаимозачет проведен' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // Возврат от клиента с защитой от минусов
    // ------------------------------------------------------------------
    router.post('/api/sales/returns', async (req, res) => {
        const { counterparty_id, items, pallets_returned, refund_method, refund_amount, account_id, reason, user_id } = req.body;

        try {
            let docNum;

            await withTransaction(pool, async (client) => {
                docNum = `ВЗ-${new Date().getTime().toString().slice(-6)}`;
                let desc = `Возврат от покупателя №${docNum}`;
                if (reason) desc += ` | Причина: ${reason}`;

                const refundAmountBig = new Big(refund_amount || 0);
                const refundAmountNum = Number(refundAmountBig.round(2));

                const retRes = await client.query(`INSERT INTO customer_returns (doc_number, counterparty_id, total_amount, reason, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [docNum, counterparty_id, refundAmountNum, reason, user_id || null]);
                const returnId = retRes.rows[0].id;

                if (pallets_returned && parseInt(pallets_returned) > 0) {
                    await client.query(`UPDATE counterparties SET pallets_balance = GREATEST(pallets_balance - $1, 0) WHERE id = $2`, [parseInt(pallets_returned), counterparty_id]);
                    desc += ` | Возврат поддонов: ${pallets_returned} шт.`;
                }

                const defaultFinishedWhId = await getWhId(client, 'finished');
                if (items && items.length > 0) {
                    for (let item of items) {
                        // 🛡️ ПАТЧ БЕЗОПАСНОСТИ: Защита от списывания склада
                        if (parseFloat(item.qty) <= 0) throw new Error(`Количество возвращаемого товара должно быть больше нуля!`);

                        const whId = item.warehouse_id || defaultFinishedWhId;
                        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id) VALUES ($1, $2, 'customer_return', $3, $4, $5)`, [item.id, item.qty, desc, whId, user_id || null]);
                        await client.query(`INSERT INTO customer_return_items (return_id, item_id, quantity, price, warehouse_id) VALUES ($1, $2, $3, $4, $5)`, [returnId, item.id, item.qty, item.price, whId]);
                    }
                }

                if (refundAmountNum > 0) {
                    if (refund_method === 'cash' && account_id) {
                        const vatAmount = Number(refundAmountBig.times(22).div(122).round(2));
                        await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, user_id) VALUES ($1, 'expense', 'Возврат средств покупателю', $2, $3, 'Сразу', $4, $5, $6)`, [refundAmountNum, desc, vatAmount, account_id, counterparty_id, user_id || null]);
                    } else if (refund_method === 'debt') {
                        await client.query(`INSERT INTO invoices (counterparty_id, invoice_number, amount, description, status, user_id) VALUES ($1, $2, $3, $4, 'paid', $5)`, [counterparty_id, docNum, -Math.abs(refundAmountNum), desc, user_id || null]);
                    }
                }
            });
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`♻️ <b>Возврат товара: ${docNum}</b>\nСумма: ${refund_amount || 0} ₽\nПричина: ${reason || 'Не указана'}`);

            res.json({ success: true, docNum, message: 'Возврат оформлен' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // Оформление заказа
    // ------------------------------------------------------------------
    router.post('/api/sales/checkout', async (req, res) => {
        const { counterparty_id, items, payment_method, account_id, advance_amount, discount, driver, auto, contract_info, poa_info, delivery_address, logistics_cost, planned_shipment_date, pallets_qty, user_id } = req.body;

        if (!items || items.length === 0) return res.status(400).json({ error: 'Корзина пуста!' });
        if (discount !== undefined && (parseFloat(discount) < 0 || parseFloat(discount) > 100)) return res.status(400).json({ error: 'Скидка должна быть от 0 до 100%!' });
        if (advance_amount !== undefined && parseFloat(advance_amount) < 0) return res.status(400).json({ error: 'Аванс не может быть отрицательным!' });

        for (let item of items) {
            if (parseFloat(item.qty) <= 0) return res.status(400).json({ error: 'Количество товара должно быть > 0!' });
            if (parseFloat(item.price) < 0) return res.status(400).json({ error: 'Цена товара не может быть отрицательной!' });
        }

        try {
            let docNum;
            let finalAmount;

            await withTransaction(pool, async (client) => {
                let subtotalAmount = new Big(0);
                docNum = await getNextDocNumber(client, 'ЗК', 'client_orders', 'doc_number');
                let desc = 'Заказ (Резерв): ' + docNum;
                if (driver || auto) desc += ` | Транспорт: ${auto || '-'} (Водитель: ${driver || '-'})`;
                if (delivery_address) desc += ` | Доставка: ${delivery_address}`;
                if (discount > 0) desc += ` | Скидка: ${discount}%`;
                if (contract_info) desc += ` | Основание: ${contract_info}`;
                if (poa_info) desc += ` | ${poa_info}`;

                if (pallets_qty && parseInt(pallets_qty) > 0) {
                    await client.query(`UPDATE counterparties SET pallets_balance = pallets_balance + $1 WHERE id = $2`, [parseInt(pallets_qty), counterparty_id]);
                    desc += ` | Поддоны (долг): ${pallets_qty} шт.`;
                }

                for (let item of items) {
                    subtotalAmount = subtotalAmount.plus(new Big(item.qty || 0).times(new Big(item.price || 0)));
                }
                const discountMultiplier = new Big(100).minus(new Big(discount || 0)).div(100);
                let finalAmountBig = subtotalAmount.times(discountMultiplier);
                if (logistics_cost && parseFloat(logistics_cost) > 0) {
                    finalAmountBig = finalAmountBig.plus(new Big(logistics_cost));
                    desc += ` | Логистика: ${logistics_cost} ₽`;
                }
                finalAmount = Number(finalAmountBig.round(2));

                const orderRes = await client.query(`INSERT INTO client_orders (doc_number, counterparty_id, total_amount, delivery_address, logistics_cost, planned_shipment_date, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [docNum, counterparty_id, finalAmount, delivery_address || null, logistics_cost || 0, planned_shipment_date || null, user_id || null]);
                const orderId = orderRes.rows[0].id;
                const reserveWhId = await getWhId(client, 'reserve');
                const defaultFinishedWhId = await getWhId(client, 'finished');

                for (let item of items) {
                    await client.query(`SELECT id FROM items WHERE id = $1 FOR UPDATE`, [item.id]);
                    const whId = item.warehouse_id || defaultFinishedWhId;
                    const stockRes = await client.query(`SELECT batch_id, SUM(quantity) as available FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2 GROUP BY batch_id HAVING SUM(quantity) > 0 ORDER BY MIN(movement_date) ASC`, [item.id, whId]);
                    let remainingNeeded = parseFloat(item.qty);
                    let qtyReserved = 0;
                    for (let row of stockRes.rows) {
                        if (remainingNeeded <= 0) break;
                        const deduct = Math.min(remainingNeeded, parseFloat(row.available));
                        remainingNeeded -= deduct;
                        qtyReserved += deduct;
                        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id) VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6)`, [item.id, -deduct, desc, whId, row.batch_id, user_id || null]);
                        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id) VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6)`, [item.id, deduct, desc, reserveWhId, row.batch_id, user_id || null]);
                    }
                    const qtyProduction = remainingNeeded;
                    if (qtyProduction > 0 && item.allow_production === false) throw new Error(`Не хватает товара (ID ${item.id})!`);
                    const itemRes = await client.query(`INSERT INTO client_order_items (order_id, item_id, qty_ordered, qty_reserved, qty_production, price) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [orderId, item.id, item.qty, qtyReserved, qtyProduction, item.price]);
                    if (qtyProduction > 0 && item.allow_production !== false) {
                        await client.query(`INSERT INTO planned_production (order_item_id, item_id, quantity) VALUES ($1, $2, $3)`, [itemRes.rows[0].id, item.id, qtyProduction]);
                    }
                }

                if (payment_method === 'debt') {
                    await client.query(`INSERT INTO invoices (counterparty_id, invoice_number, amount, description, status, user_id) VALUES ($1, $2, $3, $4, 'pending', $5)`, [counterparty_id, docNum, finalAmount, desc, user_id || null]);
                } else if (payment_method === 'paid' && account_id) {
                    const vatAmount = Number(finalAmountBig.times(22).div(122).round(2));
                    await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, user_id) VALUES ($1, 'income', 'Продажа продукции', $2, $3, 'Сразу', $4, $5, $6)`, [finalAmount, desc, vatAmount, account_id, counterparty_id, user_id || null]);
                } else if (payment_method === 'partial' && account_id) {
                    const advNum = Number(new Big(advance_amount || 0).round(2));
                    const debtNum = Number(finalAmountBig.minus(new Big(advNum)).round(2));
                    if (advNum > 0) {
                        const vatAmount = Number(new Big(advNum).times(22).div(122).round(2));
                        await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, user_id) VALUES ($1, 'income', 'Продажа продукции', $2, $3, 'Аванс', $4, $5, $6)`, [advNum, desc + ' (Аванс)', vatAmount, account_id, counterparty_id, user_id || null]);
                    }
                    if (debtNum > 0) await client.query(`INSERT INTO invoices (counterparty_id, invoice_number, amount, description, status, user_id) VALUES ($1, $2, $3, $4, 'pending', $5)`, [counterparty_id, docNum, debtNum, desc + ' (Остаток долга)', user_id || null]);
                }
            });
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`🛒 <b>Новый заказ: ${docNum}</b>\nСумма: ${finalAmount} ₽\nТовар зарезервирован на складе.`);

            res.json({ success: true, docNum, totalAmount: finalAmount, type: 'reserve' });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // Удаление заказа (Освобождение резерва)
    // ------------------------------------------------------------------
    router.delete('/api/sales/orders/:id', async (req, res) => {
        const orderId = req.params.id;
        try {
            await withTransaction(pool, async (client) => {
                const orderRes = await client.query('SELECT doc_number, counterparty_id, pallets_qty FROM client_orders WHERE id = $1', [orderId]);
                if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                const order = orderRes.rows[0];
                let palletsToReturn = parseInt(order.pallets_qty) || 0;

                if (palletsToReturn === 0) {
                    const movRes = await client.query(`SELECT description FROM inventory_movements WHERE description ILIKE $1 LIMIT 1`, [`%Заказ (Резерв): ${order.doc_number}%`]);
                    if (movRes.rows.length > 0) {
                        const match = movRes.rows[0].description.match(/Поддоны \(долг\): (\d+)/);
                        if (match) palletsToReturn = parseInt(match[1]);
                    }
                }
                if (palletsToReturn > 0) {
                    await client.query(`UPDATE counterparties SET pallets_balance = GREATEST(pallets_balance - $1, 0) WHERE id = $2`, [palletsToReturn, order.counterparty_id]);
                }
                await client.query(`DELETE FROM inventory_movements WHERE description ILIKE $1`, [`%Заказ (Резерв): ${order.doc_number}%`]);
                await client.query(`DELETE FROM invoices WHERE invoice_number = $1 AND status = 'pending'`, [order.doc_number]);
                await client.query(`DELETE FROM planned_production WHERE order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)`, [orderId]);
                await client.query('DELETE FROM client_order_items WHERE order_id = $1', [orderId]);
                await client.query('DELETE FROM client_orders WHERE id = $1', [orderId]);
            });
            res.json({ success: true, message: 'Заказ удален' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // Отгрузка по заказу
    // ------------------------------------------------------------------
    router.post('/api/sales/orders/:id/ship', async (req, res) => {
        const orderId = req.params.id;
        const { items_to_ship, driver, auto, poa_info, pallets, user_id } = req.body;

        try {
            let docNum;
            let allCompleted = true;

            await withTransaction(pool, async (client) => {
                docNum = await getNextDocNumber(client, 'УТ', 'inventory_movements', 'description');
                let desc = `${docNum} | Частичная отгрузка по Заказу`;
                if (driver || auto) desc += ` | Транспорт: ${auto || '-'} (Водитель: ${driver || '-'})`;
                if (poa_info) desc += ` | ${poa_info}`;
                if (pallets && parseInt(pallets) > 0) desc += ` | Поддоны: ${pallets} шт.`;

                const reserveWhId = await getWhId(client, 'reserve');
                for (let item of items_to_ship) {
                    if (item.qty <= 0) continue;
                    await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id, linked_order_item_id) VALUES ($1, $2, 'sales_shipment', $3, $4, $5, $6)`, [item.item_id, -item.qty, desc, reserveWhId, user_id || null, item.coi_id]);
                    await client.query(`UPDATE client_order_items SET qty_shipped = COALESCE(qty_shipped, 0) + $1 WHERE id = $2`, [item.qty, item.coi_id]);
                }
                const checkRes = await client.query(`SELECT qty_ordered, COALESCE(qty_shipped, 0) as qty_shipped FROM client_order_items WHERE order_id = $1`, [orderId]);
                for (let row of checkRes.rows) {
                    if (parseFloat(row.qty_shipped) < parseFloat(row.qty_ordered)) { allCompleted = false; break; }
                }
                if (allCompleted) await client.query(`UPDATE client_orders SET status = 'completed' WHERE id = $1`, [orderId]);
            });
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`🚚 <b>Отгрузка: ${docNum}</b>\nМашина уехала к клиенту.`);

            res.json({ success: true, docNum, isCompleted: allCompleted });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // Отмена отгрузки
    // ------------------------------------------------------------------
    router.delete('/api/sales/shipment/:docNum', async (req, res) => {
        const docNum = req.params.docNum;

        try {
            await withTransaction(pool, async (client) => {
                const moveRes = await client.query(`SELECT * FROM inventory_movements WHERE movement_type = 'sales_shipment' AND description LIKE $1`, [`${docNum}%`]);
                if (moveRes.rows.length === 0) throw new Error('Отгрузка не найдена в базе');
                let orderIdToUpdate = null;
                let palletsToReturn = 0;
                const desc = moveRes.rows[0].description;
                const palletMatch = desc.match(/Поддоны:\s*(\d+)\s*шт/i);
                if (palletMatch) palletsToReturn = parseInt(palletMatch[1]);

                for (let move of moveRes.rows) {
                    if (move.linked_order_item_id) {
                        const updateRes = await client.query(`UPDATE client_order_items SET qty_shipped = GREATEST(COALESCE(qty_shipped, 0) - $1, 0) WHERE id = $2 RETURNING order_id`, [Math.abs(parseFloat(move.quantity)), move.linked_order_item_id]);
                        if (updateRes.rows.length > 0) orderIdToUpdate = updateRes.rows[0].order_id;
                    }
                }
                if (orderIdToUpdate && palletsToReturn > 0) {
                    const orderRes = await client.query(`SELECT counterparty_id FROM client_orders WHERE id = $1`, [orderIdToUpdate]);
                    if (orderRes.rows.length > 0) await client.query(`UPDATE counterparties SET pallets_balance = GREATEST(COALESCE(pallets_balance, 0) - $1, 0) WHERE id = $2`, [palletsToReturn, orderRes.rows[0].counterparty_id]);
                }
                await client.query(`DELETE FROM inventory_movements WHERE movement_type = 'sales_shipment' AND description LIKE $1`, [`${docNum}%`]);
                if (orderIdToUpdate) await client.query(`UPDATE client_orders SET status = 'processing' WHERE id = $1 AND status = 'completed'`, [orderIdToUpdate]);
            });
            res.json({ success: true, message: 'Отгрузка отменена' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- МАРШРУТЫ ЧТЕНИЯ (SELECT) И ПРОСТЫХ ЗАПРОСОВ (Остались на pool.query) ---

    router.get('/api/sales/orders', async (req, res) => {
        try {
            const result = await pool.query(`SELECT o.id, o.doc_number, o.total_amount, o.status, o.counterparty_id, o.delivery_address, TO_CHAR(o.planned_shipment_date, 'DD.MM.YYYY') as deadline, TO_CHAR(o.created_at, 'DD.MM.YYYY HH24:MI') as date_formatted, c.name as client_name, (SELECT string_agg(i.name || ' (' || coi.qty_ordered || ' ед)', ', ') FROM client_order_items coi JOIN items i ON coi.item_id = i.id WHERE coi.order_id = o.id) as items_list, (SELECT SUM(qty_ordered) FROM client_order_items WHERE order_id = o.id) as total_ordered, (SELECT SUM(COALESCE(qty_shipped, 0)) FROM client_order_items WHERE order_id = o.id) as total_shipped, (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE description LIKE '%' || o.doc_number || '%' AND transaction_type = 'income') as paid_amount, (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE invoice_number = o.doc_number AND status = 'pending') as pending_debt, (COALESCE((SELECT SUM(amount) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'income'), 0) - COALESCE((SELECT SUM(amount) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'expense'), 0) - COALESCE((SELECT SUM(coi.qty_shipped * coi.price) FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id WHERE co.counterparty_id = o.counterparty_id), 0)) as client_balance, (COALESCE((SELECT SUM(amount) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'income'), 0) - COALESCE((SELECT SUM(amount) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'expense'), 0) - COALESCE((SELECT SUM(total_amount) FROM client_orders WHERE counterparty_id = o.counterparty_id), 0)) as projected_balance FROM client_orders o LEFT JOIN counterparties c ON o.counterparty_id = c.id WHERE o.status != 'completed' ORDER BY o.created_at DESC`);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/sales/orders/:id', async (req, res) => {
        try {
            const orderRes = await pool.query(`SELECT o.*, c.name as client_name FROM client_orders o LEFT JOIN counterparties c ON o.counterparty_id = c.id WHERE o.id = $1`, [req.params.id]);
            if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
            const itemsRes = await pool.query(`SELECT coi.*, i.name, i.unit FROM client_order_items coi JOIN items i ON coi.item_id = i.id WHERE coi.order_id = $1`, [req.params.id]);
            res.json({ order: orderRes.rows[0], items: itemsRes.rows });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/sales/history', async (req, res) => {
        try {
            const result = await pool.query(`SELECT COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) as doc_num, TO_CHAR(MAX(m.movement_date), 'DD.MM.YYYY HH24:MI') as date_formatted, SUM(ABS(m.quantity)) as total_qty, (SELECT c.name FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id JOIN counterparties c ON co.counterparty_id = c.id WHERE coi.id = MAX(m.linked_order_item_id)) as client_name FROM inventory_movements m WHERE m.movement_type = 'sales_shipment' GROUP BY COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) HAVING COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) IS NOT NULL ORDER BY MAX(m.movement_date) DESC LIMIT 100`);
            if (result.rows.length === 0) return res.json([]);
            for (let row of result.rows) {
                if (!row.doc_num) continue;
                let tx = await pool.query(`SELECT t.amount, c.name as client_name FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id WHERE t.description LIKE $1`, [`%${row.doc_num}%`]);
                if (tx.rows.length > 0) { row.amount = tx.rows[0].amount; row.client_name = row.client_name || tx.rows[0].client_name; row.payment = '💰 Оплачено'; }
                else {
                    let inv = await pool.query(`SELECT i.amount, c.name as client_name FROM invoices i LEFT JOIN counterparties c ON i.counterparty_id = c.id WHERE i.invoice_number = $1`, [row.doc_num]);
                    if (inv.rows.length > 0) { row.amount = inv.rows[0].amount; row.client_name = row.client_name || inv.rows[0].client_name; row.payment = '⏳ В долг'; }
                }
            }
            res.json(result.rows.filter(r => r.doc_num));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/sales/analytics', async (req, res) => {
        try {
            const topItems = await pool.query(`SELECT i.name, SUM(coi.qty_ordered) as total_qty, SUM(coi.qty_ordered * coi.price) as total_sum FROM client_order_items coi JOIN items i ON coi.item_id = i.id JOIN client_orders co ON coi.order_id = co.id WHERE co.status != 'cancelled' GROUP BY i.name ORDER BY total_sum DESC LIMIT 5`);
            const topClients = await pool.query(`SELECT c.name, SUM(co.total_amount) as total_sum FROM client_orders co JOIN counterparties c ON co.counterparty_id = c.id WHERE co.status != 'cancelled' GROUP BY c.name ORDER BY total_sum DESC LIMIT 5`);
            const monthRevenue = await pool.query(`SELECT SUM(total_amount) as total FROM client_orders WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE) AND status != 'cancelled'`);
            res.json({ topItems: topItems.rows, topClients: topClients.rows, monthRevenue: monthRevenue.rows[0].total || 0 });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/sales/pallets-report', async (req, res) => {
        try {
            const result = await pool.query(`SELECT id, name, phone, pallets_balance FROM counterparties WHERE pallets_balance > 0 ORDER BY pallets_balance DESC`);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/blank-orders', async (req, res) => {
        const { counterparty_id, item_id, item_name, warehouse_id, quantity, price } = req.body;
        try {
            const docNum = `БЗ-${new Date().getTime().toString().slice(-6)}`;
            const result = await pool.query(`INSERT INTO blank_orders (doc_number, counterparty_id, item_id, item_name, warehouse_id, quantity, price) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, doc_number`, [docNum, counterparty_id, item_id, item_name, warehouse_id, quantity, price]);
            res.json({ success: true, docNum: result.rows[0].doc_number, id: result.rows[0].id });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/blank-orders', async (req, res) => {
        try {
            const result = await pool.query(`SELECT b.*, c.name as client_name, TO_CHAR(b.created_at, 'DD.MM.YYYY HH24:MI') as date_formatted FROM blank_orders b LEFT JOIN counterparties c ON b.counterparty_id = c.id WHERE b.status = 'pending' ORDER BY b.created_at DESC`);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete('/api/blank-orders/:id', async (req, res) => {
        try { await pool.query('DELETE FROM blank_orders WHERE id = $1', [req.params.id]); res.json({ success: true }); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/counterparties/:id/poas', async (req, res) => {
        try {
            const result = await pool.query(`SELECT id, driver_name, number, TO_CHAR(issue_date, 'DD.MM.YYYY') as issue_date, TO_CHAR(expiry_date, 'DD.MM.YYYY') as expiry_date FROM powers_of_attorney WHERE counterparty_id = $1 AND expiry_date >= CURRENT_DATE ORDER BY expiry_date ASC`, [req.params.id]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/poas', async (req, res) => {
        const { counterparty_id, driver_name, number, issue_date, expiry_date } = req.body;
        try {
            await pool.query(`INSERT INTO powers_of_attorney (counterparty_id, driver_name, number, issue_date, expiry_date) VALUES ($1, $2, $3, $4, $5)`, [counterparty_id, driver_name, number, issue_date, expiry_date]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/counterparties/:id/contracts', async (req, res) => {
        try {
            const result = await pool.query(`SELECT c.id as contract_id, c.number as contract_number, TO_CHAR(c.date, 'DD.MM.YYYY') as contract_date, s.id as spec_id, s.number as spec_number, TO_CHAR(s.date, 'DD.MM.YYYY') as spec_date FROM contracts c LEFT JOIN specifications s ON c.id = s.contract_id WHERE c.counterparty_id = $1 ORDER BY c.date DESC, s.date DESC`, [req.params.id]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/contracts', async (req, res) => {
        try {
            const result = await pool.query(`INSERT INTO contracts (counterparty_id, number, date) VALUES ($1, $2, $3) RETURNING id`, [req.body.counterparty_id, req.body.number, req.body.date]);
            res.json({ success: true, contract_id: result.rows[0].id });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete('/api/contracts/:id', async (req, res) => {
        try { await pool.query('DELETE FROM contracts WHERE id = $1', [req.params.id]); res.json({ success: true }); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/specifications', async (req, res) => {
        try { await pool.query(`INSERT INTO specifications (contract_id, number, date) VALUES ($1, $2, $3)`, [req.body.contract_id, req.body.number, req.body.date]); res.json({ success: true }); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/sales/export-1c', async (req, res) => {
        const { month, year } = req.query;
        try {
            const startDate = `${year}-${month}-01 00:00:00`;
            const endDate = `${year}-${month}-${new Date(year, month, 0).getDate()} 23:59:59`;
            const result = await pool.query(`SELECT COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) as doc_num, TO_CHAR(m.movement_date, 'DD.MM.YYYY') as doc_date, c.inn, c.kpp, c.name as client_name, COALESCE(i.article, 'PL-' || i.id) as article, i.name as item_name, i.unit, ABS(m.quantity) as qty, coi.price FROM inventory_movements m JOIN client_order_items coi ON m.linked_order_item_id = coi.id JOIN client_orders o ON coi.order_id = o.id JOIN counterparties c ON o.counterparty_id = c.id JOIN items i ON m.item_id = i.id WHERE m.movement_type = 'sales_shipment' AND m.movement_date >= $1 AND m.movement_date <= $2 ORDER BY m.movement_date ASC`, [startDate, endDate]);
            let csv = '\uFEFFНомер Документа;Дата;ИНН;КПП;Покупатель;Артикул;Номенклатура;Ед. изм.;Количество;Цена с НДС;Сумма с НДС;Ставка НДС;Сумма НДС\n';
            result.rows.forEach(r => {
                const qty = parseFloat(r.qty) || 0; const priceWithVat = parseFloat(r.price) || 0; const sumWithVat = qty * priceWithVat;
                const vatAmount = sumWithVat - (sumWithVat / 1.22);
                csv += `${r.doc_num};${r.doc_date};${r.inn || ''};${r.kpp || ''};"${(r.client_name || '').replace(/"/g, '""')}";${r.article};"${(r.item_name || '').replace(/"/g, '""')}";${r.unit};${qty};${priceWithVat.toFixed(2).replace('.', ',')};${sumWithVat.toFixed(2).replace('.', ',')};22%;${vatAmount.toFixed(2).replace('.', ',')}\n`;
            });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="Export_1C_${month}_${year}.csv"`);
            res.send(csv);
        } catch (err) { res.status(500).send('Ошибка экспорта: ' + err.message); }
    });

    return router;
};