const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const Big = require('big.js');
const { sendNotify } = require('../utils/telegram');

const { requireAdmin } = require('../middleware/auth');
const { validateCheckout, validateReturn, validateShipment, validateTransferReserve, validateOrderStatus } = require('../middleware/validator');

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

                // 3. УДАЛЕНО: фантомные транзакции Взаимозачета создавали дубли в актах сверки.
                // Глобальный баланс вычисляется по формуле Отгрузки-Наличные. Уменьшая долг заказа, 
                // мы связываем отгрузки и аванс без создания фальшивых транзакций.

                // 4. Отражение взаимозачета в заказе
                await client.query(`
                    UPDATE client_orders 
                    SET paid_amount = GREATEST(paid_amount + $1, 0), 
                        pending_debt = GREATEST(pending_debt - $1, 0)
                    WHERE doc_number = $2
                `, [amountStr, docNum]);
            });

            res.json({ success: true, message: 'Взаимозачет проведен с использованием Big.js' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 2. Возврат от клиента с правильным НДС
    // ------------------------------------------------------------------
    router.post('/api/sales/returns', requireAdmin, validateReturn, async (req, res) => {
        const { order_id, counterparty_id, items, pallets_returned, refund_method, refund_amount, account_id, reason } = req.body;
        const user_id = req.user.id; // 🛡️ SECURITY: user_id из JWT, не из req.body

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

                // 🔗 АРХИТЕКТУРНЫЙ ФИК: Если возврат привязан к заказу —
                // синхронизируем qty_shipped и создаём shipment_reversal
                if (order_id && items && items.length > 0) {
                    const reserveWhId = await getWhId(client, 'reserve');
                    for (let item of items) {
                        const returnQty = parseFloat(item.qty) || 0;
                        // Находим позицию заказа по item_id
                        const coiRes = await client.query(
                            `SELECT id, qty_shipped FROM client_order_items WHERE order_id = $1 AND item_id = $2 LIMIT 1`,
                            [order_id, item.id]
                        );
                        if (coiRes.rows.length > 0) {
                            const coi = coiRes.rows[0];
                            const currentShipped = parseFloat(coi.qty_shipped) || 0;
                            if (currentShipped > 0) {
                                const deduct = Math.min(returnQty, currentShipped);
                                // Уменьшаем qty_shipped
                                await client.query(
                                    `UPDATE client_order_items SET qty_shipped = GREATEST(qty_shipped - $1, 0) WHERE id = $2`,
                                    [deduct, coi.id]
                                );
                                // Создаём компенсирующее движение shipment_reversal
                                await client.query(
                                    `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, linked_order_item_id, user_id)
                                     VALUES ($1, $2, 'shipment_reversal', $3, $4, $5, $6)`,
                                    [item.id, deduct, `Возврат (авто-реверс): ${docNum}`, reserveWhId, coi.id, user_id || null]
                                );
                            }
                        }
                    }

                    // Проверяем полный ли возврат → меняем статус заказа
                    const shippedRes = await client.query(
                        'SELECT COALESCE(SUM(qty_shipped), 0) as total FROM client_order_items WHERE order_id = $1',
                        [order_id]
                    );
                    const totalStillShipped = parseFloat(shippedRes.rows[0].total) || 0;
                    if (totalStillShipped === 0) {
                        await client.query(
                            `UPDATE client_orders SET status = 'returned' WHERE id = $1`,
                            [order_id]
                        );
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
                            WHERE a.id = $1
                        `, [account_id]);
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
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            sendNotify(`♻️ <b>Возврат товара: ${docNum}</b>\nСумма: ${refund_amount || 0} ₽\nПричина: ${reason || 'Не указана'}`);

            res.json({ success: true, docNum, message: 'Возврат оформлен' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 3. Оформление заказа (Без изменений, структура отличная)
    // ------------------------------------------------------------------
    router.post('/api/sales/checkout', requireAdmin, validateCheckout, async (req, res) => {
        const { counterparty_id, items, payment_method, account_id, advance_amount, offset_amount, discount, driver, auto, contract_info, contract_id, delivery_address, logistics_cost, planned_shipment_date, pallets_qty, poa_info, order_date } = req.body;
        const user_id = req.user.id; // 🛡️ SECURITY: user_id из JWT, не из req.body
        // 🛡️ AUDIT-018: проверка items перенесена в validateCheckout middleware

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

                // 💰 АВТО-ЗАЧЁТ АВАНСА: Валидация против реального баланса клиента
                let validatedOffset = 0;
                
                const balRes = await client.query(`
                    SELECT
                        (SELECT COALESCE(SUM(total_amount), 0) FROM client_orders WHERE counterparty_id = $1 AND status = 'completed') as our_shipments,
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false) as our_payments,
                        (SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase') as their_shipments,
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false) as their_payments,
                        (SELECT COALESCE(SUM(paid_amount), 0) FROM client_orders WHERE counterparty_id = $1 AND status IN ('pending', 'processing')) as pending_allocated
                `, [counterparty_id]);

                const b = balRes.rows[0];
                const realBalance = parseFloat(b.our_shipments) + parseFloat(b.our_payments) - parseFloat(b.their_shipments) - parseFloat(b.their_payments);
                const totalAdvance = realBalance < 0 ? Math.abs(realBalance) : 0;
                const availableAdvance = Math.max(0, totalAdvance - parseFloat(b.pending_allocated));

                validatedOffset = Math.min(availableAdvance, finalAmount);
                if (offset_amount && Number(offset_amount) > 0) {
                    console.warn(`Запрос offset_amount = ${offset_amount} проигнорирован. Применен авто-взаимозачет на сумму: ${validatedOffset}`);
                }

                let advanceAmt = 0;
                let pendingDebt = finalAmount;

                if (payment_method === 'paid') {
                    advanceAmt = finalAmount;  // Общая оплаченная сумма (зачёт + живые)
                    pendingDebt = 0;
                } else if (payment_method === 'partial') {
                    advanceAmt = advance_amount ? Number(advance_amount) : 0;
                    // Добавляем зачёт к оплаченной части
                    advanceAmt += validatedOffset;
                    pendingDebt = Number(finalAmountBig.minus(new Big(advanceAmt)).round(2));
                    if (pendingDebt < 0) pendingDebt = 0;
                } else {
                    // debt — но зачёт всё равно может примениться
                    advanceAmt = validatedOffset;
                    pendingDebt = Number(finalAmountBig.minus(new Big(advanceAmt)).round(2));
                    if (pendingDebt < 0) pendingDebt = 0;
                }

                const finalOrderDate = order_date ? new Date(order_date).toISOString() : new Date().toISOString();

                const orderRes = await client.query(`
                    INSERT INTO client_orders (
                        counterparty_id, doc_number, status, total_amount, paid_amount, pending_debt,
                        payment_method, account_id, discount, planned_shipment_date, delivery_address, 
                        logistics_cost, pallets_qty, driver_name, auto_number, contract_info, contract_id, specification_id, created_at
                    ) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id
                `, [counterparty_id, docNum, finalAmount, advanceAmt, pendingDebt, payment_method, account_id || null, discount, planned_shipment_date || null, delivery_address, logistics_cost, pallets_qty, driver, auto, contract_info, contract_id || null, specId, finalOrderDate]);

                const orderId = orderRes.rows[0].id;
                const reserveWhId = await getWhId(client, 'reserve');
                const defaultFinishedWhId = await getWhId(client, 'finished');

                for (let item of items) {
                    await client.query(`SELECT id FROM items WHERE id = $1 FOR UPDATE`, [item.id]);
                    const whId = item.warehouse_id || defaultFinishedWhId;
                    
                    // Сначала создаём позицию заказа, чтобы получить её ID
                    const itemRes = await client.query(`
                        INSERT INTO client_order_items (order_id, item_id, qty_ordered, qty_reserved, qty_production, price) 
                        VALUES ($1, $2, $3, 0, 0, $4) RETURNING id
                    `, [orderId, item.id, item.qty, item.price]);
                    const coi_id = itemRes.rows[0].id;

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
                        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id) VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6, $7)`, [item.id, -deduct, desc, whId, row.batch_id, user_id || null, coi_id]);
                        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id) VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6, $7)`, [item.id, deduct, desc, reserveWhId, row.batch_id, user_id || null, coi_id]);
                    }

                    const qtyProduction = remainingNeeded;
                    // Обновляем позицию заказа уже с правильными счетчиками
                    await client.query(`UPDATE client_order_items SET qty_reserved = $1, qty_production = $2 WHERE id = $3`, [qtyReserved, qtyProduction, coi_id]);

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

                // Финансы (Исправлено: раздельные проводки для живых денег и зачёта)
                let finDesc = `Заказ ${docNum}`;

                // 💰 1. ВИРТУАЛЬНАЯ ТРАНЗАКЦИЯ ЗАЧЁТА АВАНСА (УДАЛЕНО КОНЦЕПТУАЛЬНО)
                if (validatedOffset > 0) {
                    finDesc += ` (сработал авто-зачет аванса на ${validatedOffset.toFixed(2)} ₽)`;
                }

                // 💵 2. РЕАЛЬНАЯ ТРАНЗАКЦИЯ (живые деньги в кассу)
                let txAmount = 0;
                if (payment_method === 'paid') {
                    txAmount = finalAmount - validatedOffset; // Живые деньги = итого минус зачёт
                } else if (payment_method === 'partial') {
                    txAmount = advance_amount ? Number(advance_amount) : 0; // Только живые деньги аванса
                    finDesc += ' (Аванс)';
                }

                if (txAmount > 0 && account_id) {
                    await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, user_id, linked_order_id, transaction_date) VALUES ($1, 'income', 'Продажа продукции', $2, 'Сразу', $3, $4, $5, $6, $7)`, [txAmount, finDesc, account_id, counterparty_id, user_id || null, orderId, finalOrderDate]);

                    // Обновляем баланс ТОЛЬКО той кассы, куда упали деньги
                    await client.query(`
                        UPDATE accounts a 
                        SET balance = ROUND(COALESCE((
                            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) - 
                                   SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) 
                            FROM transactions t 
                            WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                        ), 0), 2)
                        WHERE a.id = $1
                    `, [account_id]);
                }
            });

            sendNotify(`🛒 <b>Новый заказ: ${docNum}</b>`);
            res.json({ success: true, docNum, totalAmount: finalAmount, deficitReport });

        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 4. Зачет Свободного Аванса в конкретный заказ
    // ------------------------------------------------------------------
    router.post('/api/sales/orders/:id/apply-advance', requireAdmin, async (req, res) => {
        const orderId = req.params.id;
        
        try {
            await withTransaction(pool, async (client) => {
                // 1. Получаем заказ с блокировкой
                const orderRes = await client.query('SELECT counterparty_id, pending_debt, status, paid_amount FROM client_orders WHERE id = $1 FOR UPDATE', [orderId]);
                if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                const order = orderRes.rows[0];

                if (order.status === 'completed' || order.status === 'cancelled') {
                    throw new Error('Нельзя изменять оплату у закрытого или отмененного заказа');
                }

                const pendingDebt = parseFloat(order.pending_debt) || 0;
                if (pendingDebt <= 0) {
                    throw new Error('У этого заказа нет долга');
                }

                const counterpartyId = order.counterparty_id;

                // 2. Вычисляем Свободный Аванс
                const balRes = await client.query(`
                    SELECT
                        (SELECT COALESCE(SUM(total_amount), 0) FROM client_orders WHERE counterparty_id = $1 AND status = 'completed') as our_shipments,
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false) as our_payments,
                        (SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase') as their_shipments,
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false) as their_payments,
                        (SELECT COALESCE(SUM(paid_amount), 0) FROM client_orders WHERE counterparty_id = $1 AND status IN ('pending', 'processing')) as pending_allocated
                `, [counterpartyId]);

                const b = balRes.rows[0];
                const realBalance = parseFloat(b.our_shipments) + parseFloat(b.our_payments) - parseFloat(b.their_shipments) - parseFloat(b.their_payments);
                
                const totalAdvance = realBalance < 0 ? Math.abs(realBalance) : 0;
                const allocated = parseFloat(b.pending_allocated);
                
                const freeAdvance = Math.max(0, totalAdvance - allocated);

                if (freeAdvance <= 0) {
                    throw new Error('У клиента нет свободного аванса для зачета (возможно, он уже зарезервирован под другие заказы)');
                }

                // 3. Зачитываем сумму
                const offsetAmount = Math.min(freeAdvance, pendingDebt);

                // 4. Обновляем заказ
                await client.query(`
                    UPDATE client_orders 
                    SET paid_amount = paid_amount + $1, 
                        pending_debt = GREATEST(pending_debt - $1, 0)
                    WHERE id = $2
                `, [offsetAmount, orderId]);
                
            });

            const io = req.app.get('io');
            if (io) { io.emit('sales_updated'); }
            
            res.json({ success: true, message: 'Свободный аванс успешно зачтен в заказ' });

        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 5. Отгрузка по заказу (ОСНОВА ДЛЯ ЧАСТИЧНЫХ ОТГРУЗОК)
    // ------------------------------------------------------------------
    router.post('/api/sales/orders/:id/ship', requireAdmin, validateShipment, async (req, res) => {
        const orderId = req.params.id;
        const { items_to_ship, driver, auto, poa_info, pallets, ship_date } = req.body;
        const user_id = req.user.id; // 🛡️ SECURITY: user_id из JWT, не из req.body
        const finalShipDate = ship_date ? new Date(ship_date).toISOString() : new Date().toISOString();

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

                    // 🔒 ШАГ 1: Блокируем позицию заказа (Row-Level Lock)
                    const coiRes = await client.query(
                        `SELECT id, item_id, qty_ordered, COALESCE(qty_shipped, 0) as qty_shipped
                         FROM client_order_items WHERE id = $1 FOR UPDATE`,
                        [item.coi_id]
                    );
                    if (coiRes.rows.length === 0) {
                        throw new Error(`Позиция заказа #${item.coi_id} не найдена.`);
                    }
                    const coi = coiRes.rows[0];
                    const remaining = parseFloat(coi.qty_ordered) - parseFloat(coi.qty_shipped);
                    if (item.qty > remaining) {
                        throw new Error(
                            `Невозможно отгрузить ${item.qty} ед. товара (позиция #${coi.id}). ` +
                            `Осталось к отгрузке: ${remaining} ед. (заказано: ${coi.qty_ordered}, уже отгружено: ${coi.qty_shipped}).`
                        );
                    }

                    // 🔒 ШАГ 2: Проверяем реальный остаток на складе резерва
                    const stockRes = await client.query(
                        `SELECT COALESCE(SUM(quantity), 0) as balance
                         FROM inventory_movements
                         WHERE item_id = $1 AND warehouse_id = $2`,
                        [item.item_id, reserveWhId]
                    );
                    let reserveBalance = parseFloat(stockRes.rows[0].balance);
                    
                    if (reserveBalance < item.qty) {
                        // АВТО-ДОБОР: Если в резерве не хватает, смотрим на Склад №4 (Свободные остатки)
                        const finishedWhId = await getWhId(client, 'finished');
                        const shortfall = parseFloat(new Big(item.qty).minus(reserveBalance).toFixed(4));
                        
                        const finishedRes = await client.query(
                            `SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`,
                            [item.item_id, finishedWhId]
                        );
                        let finishedBalance = parseFloat(finishedRes.rows[0].balance);

                        if (finishedBalance >= shortfall) {
                            // Автоматически переносим недостаницу со Склада №4 в резерв
                            await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id, linked_order_item_id, movement_date) VALUES ($1, $2, 'reserve_release_receipt', $3, $4, $5, $6, $7)`, [item.item_id, -shortfall, `Авто-перевод в резерв при отгрузке`, finishedWhId, user_id || null, item.coi_id, finalShipDate]);
                            await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id, linked_order_item_id, movement_date) VALUES ($1, $2, 'reserve_release_expense', $3, $4, $5, $6, $7)`, [item.item_id, shortfall, `Авто-добор из свободных остатков`, reserveWhId, user_id || null, item.coi_id, finalShipDate]);
                            
                            // Также корректируем qty_reserved в client_order_items, и убираем из дефицита (qty_production)
                            await client.query(`UPDATE client_order_items SET qty_reserved = COALESCE(qty_reserved, 0) + $1, qty_production = GREATEST(COALESCE(qty_production, 0) - $1, 0) WHERE id = $2`, [shortfall, item.coi_id]);
                            
                            reserveBalance = reserveBalance + shortfall; // Теперь хватает
                        } else {
                            throw new Error(
                                `Недостаточно товара для отгрузки (позиция #${coi.id}). ` +
                                `Требуется: ${item.qty}, в резерве: ${reserveBalance}, на складе свободно: ${finishedBalance}.`
                            );
                        }
                    }

                    // ✅ Всё проверено — выполняем списание и обновление
                    await client.query(
                        `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id, linked_order_item_id, movement_date)
                         VALUES ($1, $2, 'sales_shipment', $3, $4, $5, $6, $7)`,
                        [item.item_id, -item.qty, desc, reserveWhId, user_id || null, item.coi_id, finalShipDate]
                    );
                    await client.query(
                        `UPDATE client_order_items SET qty_shipped = COALESCE(qty_shipped, 0) + $1 WHERE id = $2`,
                        [item.qty, item.coi_id]
                    );
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
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            sendNotify(`🚚 <b>Отгрузка: ${docNum}</b>\nМашина уехала к клиенту.`);

            res.json({ success: true, docNum, isCompleted: allCompleted });
        } catch (err) {
            logger.error(err);
            res.status(err.message.includes('Невозможно') || err.message.includes('Недостаточно') || err.message.includes('не найдена') ? 400 : 500)
               .json({ error: err.message || 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
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
                }

                // 3. Откатываем статус заказа
                const coiSample = movements.rows[0];
                if (coiSample && coiSample.linked_order_item_id) {
                    const orderIdRes = await client.query('SELECT order_id FROM client_order_items WHERE id = $1', [coiSample.linked_order_item_id]);
                    if (orderIdRes.rows.length > 0) {
                        const targetOrderId = orderIdRes.rows[0].order_id;

                        // Все отгрузки или часть отменены — в любом случае заказ должен 
                        // вернуться в статус 'processing' (В работе), чтобы его можно было
                        // отгрузить заново. Статус 'returned' здесь был ошибкой логики.
                        await client.query(
                            `UPDATE client_orders SET status = 'processing' WHERE id = $1`,
                            [targetOrderId]
                        );
                    }
                }
            });

            const io = req.app.get('io');
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            res.json({ success: true, message: 'Отгрузка отменена, товар возвращён в резерв' });
        } catch (err) {
            logger.error(err);
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

                // ⛔ ПРОВЕРКА ОТГРУЗОК С МЕХАНИЗМОМ САМОЛЕЧЕНИЯ
                // Шаг A: Проверяем РЕАЛЬНЫЙ баланс отгрузок в inventory_movements
                const realShipBalance = await client.query(
                    `SELECT COALESCE(SUM(CASE WHEN movement_type = 'sales_shipment' THEN ABS(quantity) ELSE 0 END), 0) as shipped,
                            COALESCE(SUM(CASE WHEN movement_type = 'shipment_reversal' THEN ABS(quantity) ELSE 0 END), 0) as reversed
                     FROM inventory_movements
                     WHERE linked_order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)
                       AND movement_type IN ('sales_shipment', 'shipment_reversal')`,
                    [req.params.id]
                );
                const realShipped = parseFloat(realShipBalance.rows[0].shipped) || 0;
                const realReversed = parseFloat(realShipBalance.rows[0].reversed) || 0;
                const netShipment = realShipped - realReversed;

                // Шаг B: Читаем qty_shipped из заказа
                const shipCheck = await client.query(
                    `SELECT COALESCE(SUM(qty_shipped), 0) as total_shipped
                     FROM client_order_items WHERE order_id = $1`,
                    [req.params.id]
                );
                const bookShipped = parseFloat(shipCheck.rows[0].total_shipped) || 0;

                if (netShipment > 0) {
                    // Реальные неоткатанные отгрузки ЕСТЬ — проверяем, компенсированы ли возвратом
                    const returnCheck = await client.query(
                        `SELECT COALESCE(SUM(ABS(quantity)), 0) as returned
                         FROM inventory_movements
                         WHERE movement_type = 'customer_return'
                           AND item_id IN (SELECT item_id FROM client_order_items WHERE order_id = $1)`,
                        [req.params.id]
                    );
                    const returnedQty = parseFloat(returnCheck.rows[0].returned) || 0;

                    if (returnedQty < netShipment) {
                        throw new Error(`Нельзя удалить. По заказу есть неотменённые отгрузки (${netShipment} ед.). Перейдите в "Архив отгрузок" и нажмите ❌.`);
                    }
                }

                // Шаг C: САМОЛЕЧЕНИЕ — зачищаем все осиротевшие данные
                if (bookShipped > 0 || realShipped > 0) {
                    // Удаляем sales_shipment движения
                    await client.query(
                        `DELETE FROM inventory_movements
                         WHERE movement_type IN ('sales_shipment', 'shipment_reversal')
                           AND linked_order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)`,
                        [req.params.id]
                    );
                    // Обнуляем qty_shipped
                    await client.query(
                        `UPDATE client_order_items SET qty_shipped = 0 WHERE order_id = $1`,
                        [req.params.id]
                    );
                    // Удаляем customer_return движения привязанные к этим товарам
                    await client.query(
                        `DELETE FROM inventory_movements
                         WHERE movement_type = 'customer_return'
                           AND item_id IN (SELECT item_id FROM client_order_items WHERE order_id = $1)
                           AND description LIKE '%' || $1 || '%'`,
                        [order.doc_number]
                    );
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
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            res.json({ success: true, message: 'Заказ удалён, резервы возвращены на склад' });
        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
        }
    });
    // ------------------------------------------------------------------
    // Остальные маршруты (Analytics, Export, Status Update, etc.)
    // ------------------------------------------------------------------
    router.put('/api/sales/orders/:id/status', requireAdmin, validateOrderStatus, async (req, res) => {
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
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    

    // ------------------------------------------------------------------
    // ЗАДАЧА: РУЧНОЕ ЗАКРЫТИЕ ЗАКАЗА С ОТМЕНОЙ ОСТАТКОВ
    // ------------------------------------------------------------------
    router.put('/api/sales/orders/:id/force-close', requireAdmin, async (req, res) => {
        const orderId = req.params.id;
        
        try {
            await withTransaction(pool, async (client) => {
                const orderRes = await client.query('SELECT * FROM client_orders WHERE id = $1 FOR UPDATE', [orderId]);
                if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                const order = orderRes.rows[0];
                
                if (order.status === 'completed' || order.status === 'cancelled') {
                    throw new Error('Заказ уже закрыт или отменен');
                }
                if (order.is_locked) {
                    throw new Error('Заказ защищен режимом Нотариус.');
                }

                // 1. Снимаем все незаконченные резервы
                await client.query(`
                    UPDATE client_order_items 
                    SET qty_reserved = 0, qty_production = 0 
                    WHERE order_id = $1
                `, [orderId]);

                // 2. Снижаем qty_ordered до qty_shipped, чтобы итоговая сумма стала равна реально отгруженному
                await client.query(`
                    UPDATE client_order_items 
                    SET qty_ordered = COALESCE(qty_shipped, 0) 
                    WHERE order_id = $1 AND qty_ordered > COALESCE(qty_shipped, 0)
                `, [orderId]);

                // 3. Удаляем позиции, по которым вообще не было отгрузок (qty_shipped = 0)
                await client.query(`
                    DELETE FROM client_order_items 
                    WHERE order_id = $1 AND COALESCE(qty_shipped, 0) = 0
                `, [orderId]);

                // 4. Пересчитываем ИТОГОВУЮ СУММУ ЗАКАЗА (total_amount)
                const itemsRes = await client.query('SELECT qty_ordered, price FROM client_order_items WHERE order_id = $1', [orderId]);
                let newTotal = 0;
                itemsRes.rows.forEach(i => {
                    newTotal += parseFloat(i.qty_ordered) * parseFloat(i.price);
                });
                
                // Учитываем скидку
                const discount = parseFloat(order.discount) || 0;
                newTotal = Math.max(0, newTotal - discount);
                
                // Прибавляем логистику, если есть
                newTotal += parseFloat(order.logistics_cost || 0);

                // 5. Пересчитываем долг
                const paid = parseFloat(order.paid_amount || 0);
                const newDebt = Math.max(0, newTotal - paid);

                // 6. Обновляем статус заказа
                await client.query(`
                    UPDATE client_orders 
                    SET status = 'completed', 
                        total_amount = $1, 
                        pending_debt = $2 
                    WHERE id = $3
                `, [newTotal, newDebt, orderId]);
            });

            const io = req.app.get('io');
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            res.json({ success: true, message: 'Заказ успешно закрыт' });
        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // ЗАДАЧА: ПРЯМОЕ РЕДАКТИРОВАНИЕ ЗАКАЗА
    // ------------------------------------------------------------------
    router.put('/api/sales/orders/:id', requireAdmin, async (req, res) => {
        const orderId = req.params.id;
        const { items, counterparty_id, discount, created_at, logistics_cost, delivery_address, comment, specification_id } = req.body;
        
        try {
            await withTransaction(pool, async (client) => {
                const checkRes = await client.query('SELECT * FROM client_orders WHERE id = $1 FOR UPDATE', [orderId]);
                if (checkRes.rows.length === 0) throw new Error('Заказ не найден');
                const order = checkRes.rows[0];
                
                if (order.status === 'completed' || order.status === 'cancelled') {
                    throw new Error('Нельзя редактировать закрытый или отмененный заказ');
                }
                if (order.is_locked) throw new Error('Заказ опечатан нотариусом');
                if (!items || !Array.isArray(items)) throw new Error('Некорректный формат позиций заказа');

                // Если пытаются сохранить вообще без позиций, но есть отгрузки — выдадим ошибку
                const currentItemsRes = await client.query('SELECT * FROM client_order_items WHERE order_id = $1', [orderId]);
                const currentItems = currentItemsRes.rows;

                // 2. Обрабатываем присланные товары (обновление / добавление)
                let calculatedTotal = 0;
                
                for (let newItem of items) {
                    const itemId = parseInt(newItem.id);
                    const newQty = parseFloat(newItem.qty);
                    const price = parseFloat(newItem.price);
                    
                    if (newQty <= 0) continue; // Игнорируем или удалим позже
                    calculatedTotal += (newQty * price);
                    
                    const existingRow = currentItems.find(i => parseInt(i.item_id) === itemId);
                    
                    if (existingRow) {
                        // Товар уже был в заказе. Проверяем shipped_qty!
                        const shipped = parseFloat(existingRow.qty_shipped || 0);
                        if (newQty < shipped) {
                            throw new Error(`Нельзя уменьшить кол-во ниже уже отгруженного (${shipped})`);
                        }
                        
                        const oldQty = parseFloat(existingRow.qty_ordered);
                        
                        // Если кол-во изменилось, пересчитываем резервы
                        if (newQty !== oldQty) {
                            let newReserved = parseFloat(existingRow.qty_reserved || 0);
                            
                            if (newQty < oldQty) {
                                // Уменьшаем заказ -> Срезаем резерв, если он превышает остаток, нужный для отгрузки
                                // Доступный для резервирования остаток = qty_ordered - qty_shipped
                                const remainingToShip = newQty - shipped;
                                if (newReserved > remainingToShip) {
                                    newReserved = remainingToShip;
                                }
                            } else {
                                // Увеличиваем заказ -> Пытаемся захватить со склада
                                const delta = newQty - oldQty;
                                const stockRes = await client.query(`
                                    SELECT COALESCE(SUM(quantity),0) as q FROM inventory_movements WHERE item_id = $1
                                    `, [itemId]);
                                const physicalQty = parseFloat(stockRes.rows[0].q);
                                
                                const totalReservedRes = await client.query(`
                                    SELECT COALESCE(SUM(qty_reserved),0) as r FROM client_order_items WHERE item_id = $1
                                    `, [itemId]);
                                const otherReserved = parseFloat(totalReservedRes.rows[0].r) - parseFloat(existingRow.qty_reserved);
                                
                                const freeStock = Math.max(0, physicalQty - otherReserved);
                                const extraReserve = Math.min(delta, freeStock);
                                newReserved += extraReserve;
                            }
                            
                            await client.query(`
                                UPDATE client_order_items 
                                SET qty_ordered = $1, price = $2, qty_reserved = $3
                                WHERE id = $4
                            `, [newQty, price, newReserved, existingRow.id]);
                        } else {
                            // Только цену поменяли
                            await client.query('UPDATE client_order_items SET price = $1 WHERE id = $2', [price, existingRow.id]);
                        }
                    } else {
                        // Это НОВЫЙ товар в заказе
                        const stockRes = await client.query(`
                            SELECT COALESCE(SUM(quantity),0) as q FROM inventory_movements WHERE item_id = $1
                            `, [itemId]);
                        const physicalQty = parseFloat(stockRes.rows[0].q);
                        
                        const totalReservedRes = await client.query(`
                            SELECT COALESCE(SUM(qty_reserved),0) as r FROM client_order_items WHERE item_id = $1
                            `, [itemId]);
                        const totalReserved = parseFloat(totalReservedRes.rows[0].r);
                        
                        const freeStock = Math.max(0, physicalQty - totalReserved);
                        const reserve = Math.min(newQty, freeStock);
                        
                        await client.query(`
                            INSERT INTO client_order_items (order_id, item_id, qty_ordered, qty_reserved, qty_production, price, qty_shipped)
                            VALUES ($1, $2, $3, $4, 0, $5, 0)
                        `, [orderId, itemId, newQty, reserve, price]);
                    }
                }
                
                // 3. Удаляем товары, которых больше нет в новом массиве (если они не отгружены)
                const newIds = items.map(i => parseInt(i.id));
                for (let oldRow of currentItems) {
                    if (!newIds.includes(parseInt(oldRow.item_id))) {
                        const shipped = parseFloat(oldRow.qty_shipped || 0);
                        if (shipped > 0) throw new Error('Нельзя удалить из заказа товар, по которому уже была отгрузка.');
                        
                        await client.query('DELETE FROM client_order_items WHERE id = $1', [oldRow.id]);
                    }
                }
                
                // 4. Пересчет итоговой суммы и долга
                const parsedDiscount = parseFloat(discount || 0);
                const parsedLogistics = parseFloat(logistics_cost || 0);
                
                calculatedTotal = Math.max(0, calculatedTotal - parsedDiscount) + parsedLogistics;
                const paidAmt = parseFloat(order.paid_amount || 0);
                const newDebt = Math.max(0, calculatedTotal - paidAmt);
                
                // Прописываем новую дату. Важно - дата может быть просто YYYY-MM-DD
                let dateQueryAdd = '';
                let dbParams = [
                    counterparty_id, calculatedTotal, newDebt, parsedDiscount, 
                    parsedLogistics, delivery_address || '', comment || '', 
                    specification_id || null, orderId
                ];
                
                if (created_at && created_at.trim() !== '') {
                    // Если дата передана - обновляем
                    dateQueryAdd = ', created_at = $10';
                    dbParams.push(created_at);
                }
                
                // 5. Запись обновлений в сам заказ
                await client.query(`
                    UPDATE client_orders
                    SET counterparty_id = $1, 
                        total_amount = $2, 
                        pending_debt = $3, 
                        discount = $4,
                        logistics_cost = $5,
                        delivery_address = $6,
                        contract_info = $7,
                        specification_id = $8
                        ${dateQueryAdd}
                    WHERE id = $9
                `, dbParams);
            });

            const io = req.app.get('io');
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            res.json({ success: true, message: 'Заказ успешно отредактирован!' });
            
        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
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
                    TO_CHAR(o.planned_shipment_date, 'DD.MM.YYYY') as deadline,
                    -- Склеиваем список товаров
                    COALESCE(
                        (SELECT STRING_AGG(i.name || ' (' || coi.qty_ordered || ' ' || i.unit || ')', ', ')
                         FROM client_order_items coi
                         JOIN items i ON coi.item_id = i.id
                         WHERE coi.order_id = o.id), 
                    'Пусто') as items_list,
                    
                    (SELECT COALESCE(SUM(qty_ordered), 0) FROM client_order_items WHERE order_id = o.id) as total_ordered,
                    (SELECT COALESCE(SUM(qty_shipped), 0) FROM client_order_items WHERE order_id = o.id) as total_shipped,
                    
                    -- 💰 Реальный баланс контрагента через транзакции
                    (
                        (SELECT COALESCE(SUM(total_amount), 0) FROM client_orders WHERE counterparty_id = o.counterparty_id AND status = 'completed') +
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false) -
                        (SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = o.counterparty_id AND movement_type = 'purchase') -
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false)
                    ) as client_balance,
                    
                    -- Свободный аванс
                    GREATEST(0, ABS(LEAST(0, (
                        (SELECT COALESCE(SUM(total_amount), 0) FROM client_orders WHERE counterparty_id = o.counterparty_id AND status = 'completed') +
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false) -
                        (SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = o.counterparty_id AND movement_type = 'purchase') -
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false)
                    ))) - (SELECT COALESCE(SUM(paid_amount), 0) FROM client_orders WHERE counterparty_id = o.counterparty_id AND status IN ('pending', 'processing'))) as free_advance,

                    -- Прогноз: сумма всех незакрытых долгов
                    (SELECT COALESCE(SUM(pending_debt), 0) * -1 FROM client_orders WHERE counterparty_id = c.id AND status != 'cancelled') as projected_balance

                FROM client_orders o
                LEFT JOIN counterparties c ON o.counterparty_id = c.id
                WHERE o.status IN ('pending', 'processing')
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 10. ПЕРЕБРОСКА РЕЗЕРВОВ (Reserve Transfer)
    // ------------------------------------------------------------------
    router.get('/api/sales/reserve-donors', async (req, res) => {
        const { item_id, exclude_order_id } = req.query;
        try {
            const query = `
                SELECT coi.id as coi_id, coi.qty_reserved, coi.qty_ordered, co.doc_number, c.name as client_name
                FROM client_order_items coi
                JOIN client_orders co ON coi.order_id = co.id
                LEFT JOIN counterparties c ON co.counterparty_id = c.id
                WHERE coi.item_id = $1
                  AND coi.qty_reserved > 0
                  AND co.status IN ('pending', 'processing')
                  AND co.id != $2
                ORDER BY co.created_at ASC
            `;
            const result = await pool.query(query, [item_id, exclude_order_id]);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
        }
    });

    router.post('/api/sales/transfer-reserve', requireAdmin, validateTransferReserve, async (req, res) => {
        const { donor_coi_id, recipient_coi_id, transfer_qty } = req.body;
        const user_id = req.user.id; // 🛡️ SECURITY: user_id из JWT, не из req.body
        const qty = parseFloat(transfer_qty);
        // 🛡️ AUDIT-018: ad-hoc проверка qty <= 0 удалена — покрыта validateTransferReserve middleware

        try {
            await withTransaction(pool, async (client) => {
                // 1. Получаем данные донора
                const donorRes = await client.query('SELECT coi.*, co.doc_number FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id WHERE coi.id = $1 FOR UPDATE', [donor_coi_id]);
                if (donorRes.rows.length === 0) throw new Error('Заказ-донор не найден');
                const donor = donorRes.rows[0];

                // 2. Получаем данные реципиента
                const recRes = await client.query('SELECT coi.*, co.doc_number FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id WHERE coi.id = $1 FOR UPDATE', [recipient_coi_id]);
                if (recRes.rows.length === 0) throw new Error('Заказ-реципиент не найден');
                const recipient = recRes.rows[0];

                if (donor.item_id !== recipient.item_id) throw new Error('Товары не совпадают!');
                if (qty > parseFloat(donor.qty_reserved)) throw new Error(`Нельзя забрать больше резерва донора (${donor.qty_reserved})`);
                if (qty > parseFloat(recipient.qty_production)) throw new Error(`Нельзя зачислить больше дефицита реципиента (${recipient.qty_production})`);

                const reserveWhId = await getWhId(client, 'reserve');

                // 3. Вычисляем батчи из резерва Донора
                const stockRes = await client.query(`
                    SELECT batch_id, SUM(quantity) as available 
                    FROM inventory_movements 
                    WHERE linked_order_item_id = $1 AND warehouse_id = $2 
                    GROUP BY batch_id HAVING SUM(quantity) > 0 
                    ORDER BY MIN(movement_date) ASC
                `, [donor_coi_id, reserveWhId]);

                let remainingNeeded = qty;
                for (let row of stockRes.rows) {
                    if (remainingNeeded <= 0) break;
                    const deduct = Math.min(remainingNeeded, parseFloat(row.available));
                    remainingNeeded -= deduct;
                    
                    // Списание с Донора (Резерв -> Свободный)
                    await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id) VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6, $7)`, [donor.item_id, -deduct, `Изъятие резерва (в счет ${recipient.doc_number})`, reserveWhId, row.batch_id, user_id || null, donor_coi_id]);
                    
                    // Зачисление Реципиенту (Свободный -> Резерв)
                    await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id) VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6, $7)`, [recipient.item_id, deduct, `Перехват резерва (от ${donor.doc_number})`, reserveWhId, row.batch_id, user_id || null, recipient_coi_id]);
                }

                if (remainingNeeded > 0) throw new Error('Математическая ошибка: физических партий меньше заявленного резерва');

                // 4. Обновляем счетчики Донора
                await client.query(`UPDATE client_order_items SET qty_reserved = qty_reserved - $1, qty_production = COALESCE(qty_production, 0) + $1 WHERE id = $2`, [qty, donor_coi_id]);
                
                // Возвращаем Донора в planned_production
                const ppRes = await client.query(`SELECT id FROM planned_production WHERE order_item_id = $1`, [donor_coi_id]);
                if (ppRes.rows.length > 0) {
                    await client.query(`UPDATE planned_production SET quantity = quantity + $1 WHERE id = $2`, [qty, ppRes.rows[0].id]);
                } else {
                    await client.query(`INSERT INTO planned_production (order_item_id, item_id, quantity) VALUES ($1, $2, $3)`, [donor_coi_id, donor.item_id, qty]);
                }

                // 5. Обновляем счетчики Реципиента
                await client.query(`UPDATE client_order_items SET qty_reserved = COALESCE(qty_reserved, 0) + $1, qty_production = GREATEST(qty_production - $1, 0) WHERE id = $2`, [qty, recipient_coi_id]);
                
                // Снимаем Реципиента из planned_production
                await client.query(`UPDATE planned_production SET quantity = GREATEST(quantity - $1, 0) WHERE order_item_id = $2`, [qty, recipient_coi_id]);
                await client.query(`DELETE FROM planned_production WHERE order_item_id = $1 AND quantity <= 0`, [recipient_coi_id]);
                
            });

            const io = req.app.get('io');
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            res.json({ success: true, message: 'Резервы успешно переброшены!' });

        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
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
            logger.error(err);
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
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/sales/history', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) as doc_num, 
                    TO_CHAR(MAX(m.movement_date), 'DD.MM.YYYY HH24:MI') as date_formatted, 
                    SUM(ABS(m.quantity)) as total_qty, 
                    (SELECT c.name FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id JOIN counterparties c ON co.counterparty_id = c.id WHERE coi.id = MAX(m.linked_order_item_id)) as client_name,
                    (SELECT co.id FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id WHERE coi.id = MAX(m.linked_order_item_id)) as order_id,
                    (SELECT co.counterparty_id FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id WHERE coi.id = MAX(m.linked_order_item_id)) as client_id,
                    (SELECT co.total_amount FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id WHERE coi.id = MAX(m.linked_order_item_id)) as total_order_amount,
                    SUM(ABS(m.quantity) * COALESCE((SELECT coi.price FROM client_order_items coi WHERE coi.id = m.linked_order_item_id), 0)) as calculated_shipment_amount
                FROM inventory_movements m 
                WHERE m.movement_type = 'sales_shipment' 
                GROUP BY COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) 
                HAVING COALESCE(SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) IS NOT NULL 
                ORDER BY MAX(m.movement_date) DESC 
                LIMIT 100
            `);
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
                SELECT i.total_amount as amount, c.name as client_name, i.invoice_number 
                FROM invoices i 
                LEFT JOIN counterparties c ON i.counterparty_id = c.id 
                WHERE i.invoice_number = ANY($1::text[])
            `, [docNumsExact]);

            for (let row of validRows) {
                const tx = txRes.rows.find(t => t.description && t.description.includes(row.doc_num));
                if (tx) {
                    row.amount = parseFloat(tx.amount) || parseFloat(row.total_order_amount) || 0;
                    row.client_name = row.client_name || tx.client_name;
                    row.payment = '💰 Оплачено';
                } else {
                    const inv = invRes.rows.find(i => i.invoice_number === row.doc_num);
                    if (inv) {
                        row.amount = parseFloat(inv.amount) || parseFloat(row.total_order_amount) || 0;
                        row.client_name = row.client_name || inv.client_name;
                        row.payment = '⏳ В долг';
                    } else {
                        // Фаллбэк на сумму оригинального заказа, если счет не найден
                        row.amount = parseFloat(row.calculated_shipment_amount) || parseFloat(row.total_order_amount) || 0;
                        row.payment = '📦 Накладная';
                    }
                }
            }
            res.json(validRows);
        } catch (err) {
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/sales/pallets-report', async (req, res) => {
        try {
            const result = await pool.query(`SELECT id, name, phone, pallets_balance FROM counterparties WHERE pallets_balance > 0 ORDER BY pallets_balance DESC`);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/blank-orders', async (req, res) => {
        try {
            const result = await pool.query(`SELECT b.*, c.name as client_name, TO_CHAR(b.created_at, 'DD.MM.YYYY HH24:MI') as date_formatted FROM blank_orders b LEFT JOIN counterparties c ON b.counterparty_id = c.id WHERE b.status = 'pending' ORDER BY b.created_at DESC`);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.delete('/api/blank-orders/:id', requireAdmin, async (req, res) => {
        try { await pool.query('DELETE FROM blank_orders WHERE id = $1', [req.params.id]); res.json({ success: true }); }
        catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // === БАЛАНС КЛИЕНТА (доступный аванс) ===
    router.get('/api/counterparties/:id/balance', async (req, res) => {
        try {
            const cpId = req.params.id;
            const balRes = await pool.query(`
                SELECT
                    (SELECT COALESCE(SUM(total_amount), 0) FROM client_orders WHERE counterparty_id = $1 AND status = 'completed') as our_shipments,
                    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false) as our_payments,
                    (SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase') as their_shipments,
                    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false) as their_payments
            `, [cpId]);

            const b = balRes.rows[0];
            const realBalance = parseFloat(b.our_shipments) + parseFloat(b.our_payments) - parseFloat(b.their_shipments) - parseFloat(b.their_payments);
            const availableAdvance = realBalance < 0 ? Math.abs(realBalance) : 0;

            res.json({ availableAdvance, realBalance });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка расчёта баланса' });
        }
    });

    router.get('/api/counterparties/:id/poas', async (req, res) => {
        try {
            const result = await pool.query(`SELECT id, driver_name, number, TO_CHAR(issue_date, 'DD.MM.YYYY') as issue_date, TO_CHAR(expiry_date, 'DD.MM.YYYY') as expiry_date FROM powers_of_attorney WHERE counterparty_id = $1 AND expiry_date >= CURRENT_DATE ORDER BY expiry_date ASC`, [req.params.id]);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/poas', async (req, res) => {
        const { counterparty_id, driver_name, number, issue_date, expiry_date } = req.body;
        try {
            await pool.query(`INSERT INTO powers_of_attorney (counterparty_id, driver_name, number, issue_date, expiry_date) VALUES ($1, $2, $3, $4, $5)`, [counterparty_id, driver_name, number, issue_date, expiry_date]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/counterparties/:id/contracts', async (req, res) => {
        try {
            const result = await pool.query(`SELECT c.id as contract_id, c.number as contract_number, TO_CHAR(c.date, 'DD.MM.YYYY') as contract_date, s.id as spec_id, s.number as spec_number, TO_CHAR(s.date, 'DD.MM.YYYY') as spec_date FROM contracts c LEFT JOIN specifications s ON c.id = s.contract_id WHERE c.counterparty_id = $1 ORDER BY c.date DESC, s.date DESC`, [req.params.id]);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
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
            logger.error(err);
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
            logger.error(err);
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
            logger.error(err);
            res.status(500).send('Внутренняя ошибка сервера. Обратитесь к администратору.');
        }
    });


    return router;
};