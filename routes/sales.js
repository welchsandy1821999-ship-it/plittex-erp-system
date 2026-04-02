const express = require('express');
const router = express.Router();
const Big = require('big.js');
const { sendNotify } = require('../utils/telegram');

const { requireAdmin } = require('../middleware/auth');

module.exports = function (pool, getWhId, getNextDocNumber, withTransaction, ERP_CONFIG) {

    // ------------------------------------------------------------------
    // 1. Взаимозачет с защитой от минусов и хардкода
    // ------------------------------------------------------------------
    router.post('/api/sales/orders/offset', async (req, res) => {
        const { docNum, amount, account_id } = req.body;

        try {
            // 🚀 ЗАДАЧА №6: Инициализируем Big.js для суммы зачета
            const offsetAmount = new Big(amount || 0);

            if (offsetAmount.lte(0)) {
                return res.status(400).json({ error: 'Сумма зачета должна быть больше нуля!' });
            }

            await withTransaction(pool, async (client) => {
                // 1. Проверяем наличие заказа
                const orderRes = await client.query('SELECT id, counterparty_id FROM client_orders WHERE doc_number = $1', [docNum]);
                if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                const cpId = orderRes.rows[0].counterparty_id;
                const orderId = orderRes.rows[0].id;

                // 2. Выбор счета
                let targetAccountId = account_id;
                if (!targetAccountId) {
                    const accRes = await client.query('SELECT id FROM accounts ORDER BY id ASC LIMIT 1');
                    if (accRes.rows.length === 0) throw new Error('В системе нет ни одного счета/кассы для проведения взаимозачета');
                    targetAccountId = accRes.rows[0].id;
                }

                // 🛡️ ЗАДАЧА №3: Проверка баланса с блокировкой строки (FOR UPDATE)
                const accRes = await client.query(
                    'SELECT balance, name FROM accounts WHERE id = $1 FOR UPDATE',
                    [targetAccountId]
                );
                if (accRes.rows.length === 0) throw new Error('Выбранный счет не найден');

                // 🚀 ЗАДАЧА №6: Используем Big для текущего баланса
                const currentBalance = new Big(accRes.rows[0].balance);

                // Сравнение через метод .lt() (less than)
                if (currentBalance.lt(offsetAmount)) {
                    throw new Error(`Недостаточно средств на счете "${accRes.rows[0].name}". Баланс: ${currentBalance.toFixed(2)} ₽`);
                }

                // Подготавливаем строку для SQL (ровно 2 знака после запятой)
                const amountStr = offsetAmount.toFixed(2);

                // 3. Создаем записи в транзакциях
                await client.query(`
                    INSERT INTO transactions (account_id, counterparty_id, amount, transaction_type, category, description, payment_method, source_module, linked_order_id) 
                    VALUES ($1, $2, $3, 'expense', 'Взаимозачет', $4, 'Взаимозачет', 'sales', $5)
                `, [targetAccountId, cpId, amountStr, `Взаимозачет: списание переплаты за заказ ${docNum}`, orderId]);

                await client.query(`
                    INSERT INTO transactions (account_id, counterparty_id, amount, transaction_type, category, description, payment_method, source_module, linked_order_id) 
                    VALUES ($1, $2, $3, 'income', 'Взаимозачет', $4, 'Взаимозачет', 'sales', $5)
                `, [targetAccountId, cpId, amountStr, `Оплата по заказу ${docNum} (взаимозачет аванса)`, orderId]);

                // 5. Отражение взаимозачета в заказе
                await client.query(`
                    UPDATE client_orders 
                    SET paid_amount = GREATEST(paid_amount + $1, 0), 
                        pending_debt = GREATEST(pending_debt - $1, 0)
                    WHERE doc_number = $2
                `, [amountStr, docNum]);

                // Пересчет баланса кассы после взаимозачета
                await client.query(`
                    UPDATE accounts a 
                    SET balance = ROUND(COALESCE((
                        SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) - 
                               SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) 
                        FROM transactions t 
                        WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                    ), 0), 2)
                    WHERE a.id = $1
                `, [targetAccountId]);
            });

            res.json({ success: true, message: 'Взаимозачет проведен с использованием Big.js' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 2. Возврат от клиента с правильным НДС
    // ------------------------------------------------------------------
    router.post('/api/sales/returns', async (req, res) => {
        const { order_id, counterparty_id, items, pallets_returned, refund_method, refund_amount, account_id, reason, user_id } = req.body;

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
                        if (new Big(item.qty || 0).lte(0)) throw new Error(`Количество возвращаемого товара должно быть больше нуля!`);
                        const whId = item.warehouse_id || defaultFinishedWhId;
                        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id) VALUES ($1, $2, 'customer_return', $3, $4, $5)`, [item.id, item.qty, desc, whId, user_id || null]);
                        await client.query(`INSERT INTO customer_return_items (return_id, item_id, quantity, price, warehouse_id) VALUES ($1, $2, $3, $4, $5)`, [returnId, item.id, item.qty, item.price, whId]);
                    }
                }

                if (refundAmountNum > 0) {
                    if (refund_method === 'cash' && account_id) {
                        // 🚀 ИСПРАВЛЕНИЕ 2: НДС по глобальным настройкам
                        // Переходим на динамический делитель (100 + ставка)
                        const vatAmount = Number(refundAmountBig.times(ERP_CONFIG.vatRate).div(100 + ERP_CONFIG.vatRate).round(2));
                        await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, user_id, linked_order_id) VALUES ($1, 'expense', 'Возврат средств покупателю', $2, $3, 'Сразу', $4, $5, $6, $7)`, [refundAmountNum, desc, vatAmount, account_id, counterparty_id, user_id || null, order_id || null]);
                        
                        await client.query(`
                            UPDATE accounts a 
                            SET balance = ROUND(COALESCE((
                                SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) - 
                                       SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) 
                                FROM transactions t 
                                WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                            ), 0), 2)
                        `);
                    } else if (refund_method === 'debt') {
                        if (order_id) {
                            await client.query(`
                                UPDATE client_orders 
                                SET pending_debt = pending_debt + $1 
                                WHERE id = $2
                            `, [refundAmountNum, order_id]);
                        }
                    }
                }
            });
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`♻️ <b>Возврат товара: ${docNum}</b>\nСумма: ${refund_amount || 0} ₽\nПричина: ${reason || 'Не указана'}`);

            res.json({ success: true, docNum, message: 'Возврат оформлен' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 3. Оформление заказа (Без изменений, структура отличная)
    // ------------------------------------------------------------------
    router.post('/api/sales/checkout', requireAdmin, async (req, res) => {
        const { counterparty_id, items, payment_method, account_id, advance_amount, discount, driver, auto, contract_info, contract_id, delivery_address, logistics_cost, planned_shipment_date, pallets_qty, poa_info, user_id } = req.body;

        if (!items || items.length === 0) return res.status(400).json({ error: 'Корзина пуста!' });

        try {
            let docNum;
            let finalAmount;
            let deficitReport = []; // 🚀 Инициализируем сразу здесь, чтобы была видна везде

            await withTransaction(pool, async (client) => {
                docNum = await getNextDocNumber(client, 'ЗК', 'client_orders', 'doc_number');
                let specNum = contract_id ? `Спец к дог. ${docNum}` : `Б/Н (${docNum})`;

                const specRes = await client.query(`INSERT INTO specifications (contract_id, number, date) VALUES ($1, $2, CURRENT_DATE) RETURNING id`, [contract_id || null, specNum]);
                const specId = specRes.rows[0].id;

                let subtotalAmount = new Big(0);
                for (let item of items) {
                    const lineTotal = new Big(item.qty || 0).times(new Big(item.price || 0));
                    subtotalAmount = subtotalAmount.plus(lineTotal);
                    await client.query(`INSERT INTO specification_items (specification_id, item_id, qty, price, total_price) VALUES ($1, $2, $3, $4, $5)`, [specId, item.id, item.qty, item.price, Number(lineTotal.round(2))]);
                }

                const discountMultiplier = new Big(100).minus(new Big(discount || 0)).div(100);
                let finalAmountBig = subtotalAmount.times(discountMultiplier);
                if (logistics_cost && new Big(logistics_cost).gt(0)) {
                    finalAmountBig = finalAmountBig.plus(new Big(logistics_cost));
                }
                finalAmount = Number(finalAmountBig.round(2));

                let advanceAmt = 0;
                let pendingDebt = finalAmount;
                if (payment_method === 'paid') { advanceAmt = finalAmount; pendingDebt = 0; }
                else if (payment_method === 'partial') {
                    advanceAmt = advance_amount ? Number(advance_amount) : 0;
                    pendingDebt = Number(finalAmountBig.minus(new Big(advanceAmt)).round(2));
                }

                const orderRes = await client.query(`
                    INSERT INTO client_orders (
                        counterparty_id, doc_number, status, total_amount, paid_amount, pending_debt,
                        payment_method, account_id, discount, planned_shipment_date, delivery_address, 
                        logistics_cost, pallets_qty, driver_name, auto_number, contract_info, contract_id, specification_id
                    ) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id
                `, [counterparty_id, docNum, finalAmount, advanceAmt, pendingDebt, payment_method, account_id || null, discount, planned_shipment_date || null, delivery_address, logistics_cost, pallets_qty, driver, auto, contract_info, contract_id || null, specId]);

                const orderId = orderRes.rows[0].id;
                const reserveWhId = await getWhId(client, 'reserve');
                const defaultFinishedWhId = await getWhId(client, 'finished');

                for (let item of items) {
                    await client.query(`SELECT id FROM items WHERE id = $1 FOR UPDATE`, [item.id]);
                    const whId = item.warehouse_id || defaultFinishedWhId;
                    const stockRes = await client.query(`
                        SELECT batch_id, SUM(quantity) as available 
                        FROM inventory_movements 
                        WHERE item_id = $1 AND warehouse_id = $2 
                        GROUP BY batch_id HAVING SUM(quantity) > 0 
                        ORDER BY MIN(movement_date) ASC
                    `, [item.id, whId]);

                    let remainingNeeded = Number(new Big(item.qty || 0));
                    let qtyReserved = 0;
                    let desc = `Заказ (Резерв): ${docNum}`;

                    for (let row of stockRes.rows) {
                        if (remainingNeeded <= 0) break;
                        const deduct = Math.min(remainingNeeded, Number(new Big(row.available || 0)));
                        remainingNeeded -= deduct;
                        qtyReserved += deduct;
                        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id) VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6)`, [item.id, -deduct, desc, whId, row.batch_id, user_id || null]);
                        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id) VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6)`, [item.id, deduct, desc, reserveWhId, row.batch_id, user_id || null]);
                    }

                    const qtyProduction = remainingNeeded;
                    const itemRes = await client.query(`
                        INSERT INTO client_order_items (order_id, item_id, qty_ordered, qty_reserved, qty_production, price) 
                        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
                    `, [orderId, item.id, item.qty, qtyReserved, qtyProduction, item.price]);

                    if (qtyProduction > 0) {
                        await client.query(`INSERT INTO planned_production (order_item_id, item_id, quantity) VALUES ($1, $2, $3)`, [itemRes.rows[0].id, item.id, qtyProduction]);

                        // 🚀 ПРОВЕРКА ДЕФИЦИТА (Внутри транзакции)
                        const recipeRes = await client.query(`SELECT material_id, quantity_per_unit FROM recipes WHERE product_id = $1`, [item.id]);
                        for (let mat of recipeRes.rows) {
                            const totalNeededBig = new Big(mat.quantity_per_unit || 0).times(qtyProduction);
                            const totalNeeded = Number(totalNeededBig.round(2));

                            const materialStockRes = await client.query(`
                                SELECT i.name, COALESCE(SUM(m.quantity), 0) as balance 
                                FROM items i 
                                LEFT JOIN inventory_movements m ON i.id = m.item_id
                                WHERE i.id = $1 
                                GROUP BY i.name
                            `, [mat.material_id]);

                            const balance = materialStockRes.rows[0] ? Number(new Big(materialStockRes.rows[0].balance || 0).round(2)) : 0;
                            if (balance < totalNeeded) {
                                deficitReport.push({
                                    name: materialStockRes.rows[0]?.name || 'Материал',
                                    needed: totalNeeded.toFixed(2),
                                    shortage: (totalNeeded - balance).toFixed(2)
                                });
                            }
                        }
                    }
                }

                // Финансы
                let finDesc = `Заказ ${docNum}`;
                if (payment_method === 'paid' && account_id) {
                    await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, user_id, linked_order_id) VALUES ($1, 'income', 'Продажа продукции', $2, 'Сразу', $3, $4, $5, $6)`, [finalAmount, finDesc, account_id, counterparty_id, user_id || null, orderId]);
                    
                    await client.query(`
                        UPDATE accounts a 
                        SET balance = ROUND(COALESCE((
                            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) - 
                                   SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) 
                            FROM transactions t 
                            WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                        ), 0), 2)
                    `);
                }
            });

            sendNotify(`🛒 <b>Новый заказ: ${docNum}</b>`);
            res.json({ success: true, docNum, totalAmount: finalAmount, deficitReport });

        } catch (err) {
            console.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 4. Удаление заказа (ДУБЛИКАТ УДАЛЁН — единственный обработчик ниже в блоке 6)
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 5. Отгрузка по заказу (ОСНОВА ДЛЯ ЧАСТИЧНЫХ ОТГРУЗОК)
    // ------------------------------------------------------------------
    router.post('/api/sales/orders/:id/ship', requireAdmin, async (req, res) => {
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

                if (pallets && parseInt(pallets) > 0) {
                    desc += ` | Поддоны: ${pallets} шт.`;
                    const orderClientRes = await client.query(`SELECT counterparty_id FROM client_orders WHERE id = $1`, [orderId]);
                    if (orderClientRes.rows.length > 0) {
                        await client.query(`UPDATE counterparties SET pallets_balance = COALESCE(pallets_balance, 0) + $1 WHERE id = $2`, [parseInt(pallets), orderClientRes.rows[0].counterparty_id]);
                    }
                }

                const reserveWhId = await getWhId(client, 'reserve');
                for (let item of items_to_ship) {
                    if (item.qty <= 0) continue;
                    await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id, linked_order_item_id) VALUES ($1, $2, 'sales_shipment', $3, $4, $5, $6)`, [item.item_id, -item.qty, desc, reserveWhId, user_id || null, item.coi_id]);
                    await client.query(`UPDATE client_order_items SET qty_shipped = COALESCE(qty_shipped, 0) + $1 WHERE id = $2`, [item.qty, item.coi_id]);
                }

                const checkRes = await client.query(`SELECT qty_ordered, COALESCE(qty_shipped, 0) as qty_shipped FROM client_order_items WHERE order_id = $1`, [orderId]);
                for (let row of checkRes.rows) {
                    if (new Big(row.qty_shipped || 0).lt(row.qty_ordered || 0)) { allCompleted = false; break; }
                }

                if (allCompleted) {
                    await client.query(`UPDATE client_orders SET status = 'completed' WHERE id = $1`, [orderId]);
                } else {
                    await client.query(`UPDATE client_orders SET status = 'processing' WHERE id = $1 AND status = 'pending'`, [orderId]);
                }
            });
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`🚚 <b>Отгрузка: ${docNum}</b>\nМашина уехала к клиенту.`);

            res.json({ success: true, docNum, isCompleted: allCompleted });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 6. Отмена отгрузки (ИСПРАВЛЕНО: возврат товара в Резерв)
    // ------------------------------------------------------------------
    router.delete('/api/sales/shipments/:docNum', requireAdmin, async (req, res) => {
        const { docNum } = req.params;

        try {
            await withTransaction(pool, async (client) => {
                const reserveWhId = await getWhId(client, 'reserve');

                // 1. Ищем все движения склада по этой отгрузке
                const movements = await client.query(
                    'SELECT id, item_id, quantity, batch_id, linked_order_item_id FROM inventory_movements WHERE description LIKE $1 AND movement_type = $2',
                    [`%${docNum}%`, 'sales_shipment']
                );

                if (movements.rows.length === 0) {
                    throw new Error('Отгрузка не найдена или уже была отменена.');
                }

                // 2. Для каждой записи: уменьшаем qty_shipped, удаляем запись, ВОЗВРАЩАЕМ товар в Резерв
                for (const m of movements.rows) {
                    const returnQty = Math.abs(m.quantity);

                    // 2a. Откатываем счётчик отгрузки
                    await client.query(
                        'UPDATE client_order_items SET qty_shipped = GREATEST(COALESCE(qty_shipped, 0) - $1, 0) WHERE id = $2',
                        [returnQty, m.linked_order_item_id]
                    );

                    // 2b. Удаляем оригинальную запись sales_shipment
                    await client.query('DELETE FROM inventory_movements WHERE id = $1', [m.id]);

                    // 2c. 🛡️ ВОЗВРАЩАЕМ товар на Склад №7 (Резерв)
                    await client.query(
                        `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, linked_order_item_id)
                         VALUES ($1, $2, 'shipment_reversal', $3, $4, $5, $6)`,
                        [m.item_id, returnQty, `Отмена отгрузки: ${docNum}`, reserveWhId, m.batch_id || null, m.linked_order_item_id]
                    );
                }

                // 3. Откатываем статус заказа на processing (если был completed)
                const coiSample = movements.rows[0];
                if (coiSample.linked_order_item_id) {
                    const orderIdRes = await client.query('SELECT order_id FROM client_order_items WHERE id = $1', [coiSample.linked_order_item_id]);
                    if (orderIdRes.rows.length > 0) {
                        await client.query(
                            `UPDATE client_orders SET status = 'processing' WHERE id = $1 AND status = 'completed'`,
                            [orderIdRes.rows[0].order_id]
                        );
                    }
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: 'Отгрузка отменена, товар возвращён в резерв' });
        } catch (err) {
            console.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 7. Удаление заказа (ЕДИНСТВЕННЫЙ обработчик, с точечным откатом резерва)
    // ------------------------------------------------------------------
    router.delete('/api/sales/orders/:id', requireAdmin, async (req, res) => {
        try {
            await withTransaction(pool, async (client) => {
                const orderRes = await client.query('SELECT doc_number, paid_amount FROM client_orders WHERE id = $1', [req.params.id]);
                if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                const order = orderRes.rows[0];

                // ⛔ Проверка на оплаты
                if (new Big(order.paid_amount || 0).gt(0)) {
                    throw new Error(`Нельзя удалить. По заказу числится оплата ${order.paid_amount} ₽. Сначала удалите платежи в Финансах.`);
                }

                // ⛔ Проверка на отгрузки (по movement_type, а не по ILIKE)
                const shipCheck = await client.query(
                    `SELECT id FROM inventory_movements 
                     WHERE movement_type = 'sales_shipment' 
                       AND linked_order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1) 
                     LIMIT 1`,
                    [req.params.id]
                );
                if (shipCheck.rows.length > 0) {
                    throw new Error('Нельзя удалить. По заказу есть отгрузки. Сначала отмените их.');
                }

                // 🛡️ Точечный возврат из Резерва на Готовую продукцию
                const reserveWhId = await getWhId(client, 'reserve');
                const finishedWhId = await getWhId(client, 'finished');
                const orderItemIds = await client.query('SELECT id FROM client_order_items WHERE order_id = $1', [req.params.id]);
                const coiIds = orderItemIds.rows.map(r => r.id);

                if (coiIds.length > 0) {
                    // Находим все reserve_expense и reserve_receipt по позициям заказа
                    const reserveMoves = await client.query(
                        `SELECT id, item_id, quantity, batch_id, warehouse_id, movement_type 
                         FROM inventory_movements 
                         WHERE movement_type IN ('reserve_expense', 'reserve_receipt') 
                           AND description LIKE $1`,
                        [`%Заказ (Резерв): ${order.doc_number}%`]
                    );

                    // Удаляем парные движения резерва (они взаимно компенсируются)
                    for (const mv of reserveMoves.rows) {
                        await client.query('DELETE FROM inventory_movements WHERE id = $1', [mv.id]);
                    }
                }

                // Удаляем плановое производство
                await client.query(
                    `DELETE FROM planned_production WHERE order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)`,
                    [req.params.id]
                );

                // Мягкое удаление финансовых транзакций
                await client.query(`UPDATE transactions SET is_deleted = true WHERE linked_order_id = $1`, [req.params.id]);

                // Удаляем позиции и сам заказ
                await client.query('DELETE FROM client_order_items WHERE order_id = $1', [req.params.id]);
                await client.query('DELETE FROM client_orders WHERE id = $1', [req.params.id]);

                // Откатываем счётчик номера документа
                const numMatch = order.doc_number.match(/\d+/);
                if (numMatch) {
                    const deletedNum = parseInt(numMatch[0], 10);
                    await client.query(
                        `UPDATE document_counters SET last_number = last_number - 1 WHERE prefix = 'ЗК' AND last_number = $1`,
                        [deletedNum]
                    );
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: 'Заказ удалён, резервы возвращены на склад' });
        } catch (err) {
            console.error(err);
            res.status(400).json({ error: err.message });
        }
    });
    // ------------------------------------------------------------------
    // Остальные маршруты (Analytics, Export, Status Update, etc.)
    // ------------------------------------------------------------------
    router.put('/api/sales/orders/:id/status', requireAdmin, async (req, res) => {
        const orderId = req.params.id;
        const { status } = req.body;
        try {
            const checkRes = await pool.query('SELECT is_locked FROM client_orders WHERE id = $1', [orderId]);
            if (checkRes.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
            if (checkRes.rows[0].is_locked === true) {
                return res.status(403).json({ success: false, error: 'Заказ защищен режимом "Нотариус" (опечатан). Изменение статуса запрещено.' });
            }

            await pool.query(`UPDATE client_orders SET status = $1 WHERE id = $2`, [status, orderId]);
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // ЗАДАЧА №9: УМНЫЙ ПОИСК ЗАКАЗОВ (Авто, Водитель, Телефон, Имя)
    // ------------------------------------------------------------------
    router.get('/api/sales/orders', async (req, res) => {
        const { start, end, search } = req.query;

        try {
            let query = `
                SELECT 
                    o.*, 
                    c.name as client_name,
                    TO_CHAR(o.created_at, 'DD.MM.YYYY HH24:MI') as date_formatted,
                    
                    -- Склеиваем список товаров
                    COALESCE(
                        (SELECT STRING_AGG(i.name || ' (' || coi.qty_ordered || ' ' || i.unit || ')', ', ')
                         FROM client_order_items coi
                         JOIN items i ON coi.item_id = i.id
                         WHERE coi.order_id = o.id), 
                    'Пусто') as items_list,
                    
                    (SELECT COALESCE(SUM(qty_ordered), 0) FROM client_order_items WHERE order_id = o.id) as total_ordered,
                    (SELECT COALESCE(SUM(qty_shipped), 0) FROM client_order_items WHERE order_id = o.id) as total_shipped,
                    
                    -- 🚀 НОВОЕ: Считаем текущий долг по неоплаченным счетам (умножаем на -1 для красивого вывода)
                    (SELECT COALESCE(SUM(pending_debt), 0) * -1 FROM client_orders WHERE counterparty_id = c.id AND (status = 'pending' OR status = 'processing')) as client_balance,
                    
                    -- 🚀 НОВОЕ: Считаем общий прогноз долга по всем текущим заказам
                    (SELECT COALESCE(SUM(pending_debt), 0) * -1 FROM client_orders WHERE counterparty_id = c.id AND status != 'cancelled') as projected_balance

                FROM client_orders o
                LEFT JOIN counterparties c ON o.counterparty_id = c.id
                WHERE 1=1
            `;
            const params = [];

            // 1. Фильтр по датам (если переданы)
            if (start && end) {
                params.push(start, end);
                query += ` AND o.created_at BETWEEN $${params.length - 1} AND $${params.length}`;
            }

            // 2. ГЛОБАЛЬНЫЙ ПОИСК (Задача №9)
            if (search && search.trim() !== '') {
                const searchVal = `%${search.trim()}%`;
                params.push(searchVal);
                const pIdx = params.length;

                query += ` AND (
                    o.doc_number ILIKE $${pIdx} OR 
                    o.auto_number ILIKE $${pIdx} OR 
                    o.driver_name ILIKE $${pIdx} OR 
                    c.name ILIKE $${pIdx} OR
                    c.phone ILIKE $${pIdx}
                )`;
            }

            query += ` ORDER BY o.created_at DESC LIMIT 100`;

            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Получение деталей заказа по ID
    router.get('/api/sales/orders/:id', async (req, res) => {
        const orderId = req.params.id;
        try {
            // 1. Проверяем сам заказ (с защитой от падения при o.*)
            const orderRes = await pool.query(`
                SELECT o.*, c.name as client_name 
                FROM client_orders o 
                LEFT JOIN counterparties c ON o.counterparty_id = c.id 
                WHERE o.id = $1
            `, [orderId]);

            if (orderRes.rows.length === 0) {
                return res.status(404).json({ error: 'Заказ не найден' });
            }

            // 2. Получаем товары заказа
            const itemsRes = await pool.query(`
                SELECT coi.*, i.name, i.unit 
                FROM client_order_items coi 
                JOIN items i ON coi.item_id = i.id 
                WHERE coi.order_id = $1
            `, [orderId]);

            res.json({ order: orderRes.rows[0], items: itemsRes.rows });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/sales/contracts/:clientId', async (req, res) => {
        try {
            const result = await pool.query(`SELECT id, number, date_formatted, name FROM contracts WHERE counterparty_id = $1 AND status = 'active' ORDER BY created_at DESC`, [req.params.clientId]);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.delete('/api/contracts/:id', requireAdmin, async (req, res) => {
        const contractId = req.params.id;
        try {
            await withTransaction(pool, async (client) => {
                const specsRes = await client.query('SELECT id, number FROM specifications WHERE contract_id = $1 LIMIT 1', [contractId]);
                if (specsRes.rows.length > 0) throw new Error(`ОШИБКА: Внутри есть спецификация №${specsRes.rows[0].number}. Сначала удалите её!`);
                const ordersRes = await client.query('SELECT id, doc_number FROM client_orders WHERE contract_id = $1 LIMIT 1', [contractId]);
                if (ordersRes.rows.length > 0) throw new Error(`ОШИБКА: К договору привязан заказ (${ordersRes.rows[0].doc_number}).`);
                await client.query('DELETE FROM contracts WHERE id = $1', [contractId]);
            });
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    router.delete('/api/specifications/:id', requireAdmin, async (req, res) => {
        try { 
            await withTransaction(pool, async (client) => {
                await client.query('DELETE FROM specifications WHERE id = $1', [req.params.id]); 
            });
            res.json({ success: true }); 
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/sales/history', async (req, res) => {
        try {
            const result = await pool.query(`SELECT COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) as doc_num, TO_CHAR(MAX(m.movement_date), 'DD.MM.YYYY HH24:MI') as date_formatted, SUM(ABS(m.quantity)) as total_qty, (SELECT c.name FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id JOIN counterparties c ON co.counterparty_id = c.id WHERE coi.id = MAX(m.linked_order_item_id)) as client_name FROM inventory_movements m WHERE m.movement_type = 'sales_shipment' GROUP BY COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) HAVING COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) IS NOT NULL ORDER BY MAX(m.movement_date) DESC LIMIT 100`);
            if (result.rows.length === 0) return res.json([]);
            const validRows = result.rows.filter(r => r.doc_num);
            if (validRows.length === 0) return res.json([]);
            
            const docNumsPattern = validRows.map(r => '%' + r.doc_num + '%');
            const docNumsExact = validRows.map(r => r.doc_num);

            const txRes = await pool.query(`
                SELECT t.amount, c.name as client_name, t.description 
                FROM transactions t 
                LEFT JOIN counterparties c ON t.counterparty_id = c.id 
                WHERE t.description LIKE ANY($1::text[])
            `, [docNumsPattern]);
            
            const invRes = await pool.query(`
                SELECT i.amount, c.name as client_name, i.invoice_number 
                FROM invoices i 
                LEFT JOIN counterparties c ON i.counterparty_id = c.id 
                WHERE i.invoice_number = ANY($1::text[])
            `, [docNumsExact]);

            for (let row of validRows) {
                const tx = txRes.rows.find(t => t.description && t.description.includes(row.doc_num));
                if (tx) { 
                    row.amount = tx.amount; 
                    row.client_name = row.client_name || tx.client_name; 
                    row.payment = '💰 Оплачено'; 
                } else {
                    const inv = invRes.rows.find(i => i.invoice_number === row.doc_num);
                    if (inv) { 
                        row.amount = inv.amount; 
                        row.client_name = row.client_name || inv.client_name; 
                        row.payment = '⏳ В долг'; 
                    }
                }
            }
            res.json(validRows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/sales/analytics', async (req, res) => {
        try {
            const topItems = await pool.query(`SELECT i.name, SUM(coi.qty_ordered) as total_qty, SUM(coi.qty_ordered * coi.price) as total_sum FROM client_order_items coi JOIN items i ON coi.item_id = i.id JOIN client_orders co ON coi.order_id = co.id WHERE co.status != 'cancelled' GROUP BY i.name ORDER BY total_sum DESC LIMIT 5`);
            const topClients = await pool.query(`SELECT c.name, SUM(co.total_amount) as total_sum FROM client_orders co JOIN counterparties c ON co.counterparty_id = c.id WHERE co.status != 'cancelled' GROUP BY c.name ORDER BY total_sum DESC LIMIT 5`);
            const monthRevenue = await pool.query(`SELECT SUM(total_amount) as total FROM client_orders WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE) AND status != 'cancelled'`);
            res.json({ topItems: topItems.rows, topClients: topClients.rows, monthRevenue: monthRevenue.rows[0].total || 0 });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/sales/pallets-report', async (req, res) => {
        try {
            const result = await pool.query(`SELECT id, name, phone, pallets_balance FROM counterparties WHERE pallets_balance > 0 ORDER BY pallets_balance DESC`);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/blank-orders', async (req, res) => {
        const { counterparty_id, item_id, item_name, warehouse_id, quantity, price } = req.body;
        try {
            const docNum = `БЗ-${new Date().getTime().toString().slice(-6)}`;
            const result = await pool.query(`INSERT INTO blank_orders (doc_number, counterparty_id, item_id, item_name, warehouse_id, quantity, price) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, doc_number`, [docNum, counterparty_id, item_id, item_name, warehouse_id, quantity, price]);
            res.json({ success: true, docNum: result.rows[0].doc_number, id: result.rows[0].id });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/blank-orders', async (req, res) => {
        try {
            const result = await pool.query(`SELECT b.*, c.name as client_name, TO_CHAR(b.created_at, 'DD.MM.YYYY HH24:MI') as date_formatted FROM blank_orders b LEFT JOIN counterparties c ON b.counterparty_id = c.id WHERE b.status = 'pending' ORDER BY b.created_at DESC`);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.delete('/api/blank-orders/:id', requireAdmin, async (req, res) => {
        try { await pool.query('DELETE FROM blank_orders WHERE id = $1', [req.params.id]); res.json({ success: true }); }
        catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/counterparties/:id/poas', async (req, res) => {
        try {
            const result = await pool.query(`SELECT id, driver_name, number, TO_CHAR(issue_date, 'DD.MM.YYYY') as issue_date, TO_CHAR(expiry_date, 'DD.MM.YYYY') as expiry_date FROM powers_of_attorney WHERE counterparty_id = $1 AND expiry_date >= CURRENT_DATE ORDER BY expiry_date ASC`, [req.params.id]);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/poas', async (req, res) => {
        const { counterparty_id, driver_name, number, issue_date, expiry_date } = req.body;
        try {
            await pool.query(`INSERT INTO powers_of_attorney (counterparty_id, driver_name, number, issue_date, expiry_date) VALUES ($1, $2, $3, $4, $5)`, [counterparty_id, driver_name, number, issue_date, expiry_date]);
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/counterparties/:id/contracts', async (req, res) => {
        try {
            const result = await pool.query(`SELECT c.id as contract_id, c.number as contract_number, TO_CHAR(c.date, 'DD.MM.YYYY') as contract_date, s.id as spec_id, s.number as spec_number, TO_CHAR(s.date, 'DD.MM.YYYY') as spec_date FROM contracts c LEFT JOIN specifications s ON c.id = s.contract_id WHERE c.counterparty_id = $1 ORDER BY c.date DESC, s.date DESC`, [req.params.id]);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/contracts', async (req, res) => {
        try {
            let contractId;
            await withTransaction(pool, async (client) => {
                const result = await client.query(`INSERT INTO contracts (counterparty_id, number, date) VALUES ($1, $2, $3) RETURNING id`, [req.body.counterparty_id, req.body.number, req.body.date]);
                contractId = result.rows[0].id;
            });
            res.json({ success: true, contract_id: contractId });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/specifications', async (req, res) => {
        try { 
            await withTransaction(pool, async (client) => {
                await client.query(`INSERT INTO specifications (contract_id, number, date) VALUES ($1, $2, $3)`, [req.body.contract_id, req.body.number, req.body.date]); 
            });
            res.json({ success: true }); 
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // 🚀 ИСПРАВЛЕНИЕ: Выгрузка в 1С (НДС берется из глобальных настроек)
    router.get('/api/sales/export-1c', async (req, res) => {
        const { month, year } = req.query;
        try {
            const startDate = `${year}-${month}-01 00:00:00`;
            const endDate = `${year}-${month}-${new Date(year, month, 0).getDate()} 23:59:59`;
            const result = await pool.query(`SELECT COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) as doc_num, TO_CHAR(m.movement_date, 'DD.MM.YYYY') as doc_date, c.inn, c.kpp, c.name as client_name, COALESCE(i.article, 'PL-' || i.id) as article, i.name as item_name, i.unit, ABS(m.quantity) as qty, coi.price FROM inventory_movements m JOIN client_order_items coi ON m.linked_order_item_id = coi.id JOIN client_orders o ON coi.order_id = o.id JOIN counterparties c ON o.counterparty_id = c.id JOIN items i ON m.item_id = i.id WHERE m.movement_type = 'sales_shipment' AND m.movement_date >= $1 AND m.movement_date <= $2 ORDER BY m.movement_date ASC`, [startDate, endDate]);
            let csv = '\uFEFFНомер Документа;Дата;ИНН;КПП;Покупатель;Артикул;Номенклатура;Ед. изм.;Количество;Цена с НДС;Сумма с НДС;Ставка НДС;Сумма НДС\n';
            result.rows.forEach(r => {
                const qtyStr = r.qty || 0;
                const priceStr = r.price || 0;
                
                const qtyBig = new Big(qtyStr);
                const priceBig = new Big(priceStr);
                const sumWithVatBig = qtyBig.times(priceBig);
                const sumWithVat = Number(sumWithVatBig.toFixed(2));

                const vatAmountBig = sumWithVatBig.minus(sumWithVatBig.div(1 + ERP_CONFIG.vatRate / 100));
                const vatAmount = Number(vatAmountBig.toFixed(2));

                csv += `${r.doc_num};${r.doc_date};${r.inn || ''};${r.kpp || ''};"${(r.client_name || '').replace(/"/g, '""')}";${r.article};"${(r.item_name || '').replace(/"/g, '""')}";${r.unit};${Number(qtyBig)};${Number(priceBig).toFixed(2).replace('.', ',')};${sumWithVat.toFixed(2).replace('.', ',')};${ERP_CONFIG.vatRate}%;${vatAmount.toFixed(2).replace('.', ',')}\n`;
            });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="Export_1C_${month}_${year}.csv"`);
            res.send(csv);
        } catch (err) {
            console.error(err);
            res.status(500).send('Внутренняя ошибка сервера. Обратитесь к администратору.');
        }
    });

    return router;
};