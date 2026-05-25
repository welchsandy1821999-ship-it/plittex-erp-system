const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const Big = require('big.js');
const { sendNotify, escapeHtml, formatMoney, NOTIFY_CB, notifyCounterpartyBalanceChange } = require('../utils/telegram');
const { auditLog } = require('../utils/db_init');
const {
    SETTLEMENT_MODES,
    money,
    normalizeSettlementMode,
    planSettlementActions,
    getOrderSettlementSnapshot,
    reconcileOrderSettlement
} = require('../utils/orderSettlement');
const { estimatePalletsFromRecipes } = require('../utils/palletRecipeEstimate');
const { buildSalesAnalyticsUnitCostData } = require('../utils/salesAnalyticsUnitCost');
const { getCounterpartyBalance } = require('../utils/counterpartyBalance');
const { recalcAccountBalances } = require('../utils/accountBalances');
const { resolveShipmentMovementTimestamp } = require('../utils/mskTime');

const { requireAdmin } = require('../middleware/auth');
const { validateCheckout, validateReturn, validateShipment, validateTransferReserve, validateOrderStatus } = require('../middleware/validator');

module.exports = function (pool, getWhId, getNextDocNumber, withTransaction, ERP_CONFIG) {
    async function lockStockKey(client, itemId, warehouseId) {
        const i = Number(itemId);
        const w = Number(warehouseId);
        if (!Number.isInteger(i) || i <= 0 || !Number.isInteger(w) || w <= 0) return;
        await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [i, w]);
    }

    async function lockStockPair(client, itemId, warehouseA, warehouseB) {
        const pairs = [Number(warehouseA), Number(warehouseB)]
            .filter((v) => Number.isInteger(v) && v > 0);
        const sorted = Array.from(new Set(pairs)).sort((a, b) => a - b);
        for (const whId of sorted) {
            await lockStockKey(client, itemId, whId);
        }
    }

    function mapDbError(err, fallback) {
        if (err && (err.code === '23514' || err.code === 'P0001')) {
            return err.message || fallback;
        }
        return fallback;
    }

    /**
     * client_orders.discount: <= 100 — процент на товары; > 100 — абсолютная скидка в рублях.
     * baseGrossBig — валовая база заказа для пропорционального выделения рублёвой скидки (частичная отгрузка).
     */
    function applySmartDiscount(grossBig, discountRaw, baseGrossBig = null) {
        const gross = new Big(grossBig || 0);
        const discount = new Big(discountRaw || 0);
        if (discount.lte(0)) return gross;
        if (discount.lte(100)) {
            return gross.times(new Big(100).minus(discount).div(100));
        }
        const absDiscount = discount;
        const base = baseGrossBig != null ? new Big(baseGrossBig || 0) : null;
        if (base && base.gt(0) && base.gt(gross)) {
            const allocated = absDiscount.times(gross.div(base));
            const net = gross.minus(allocated);
            return net.lt(0) ? new Big(0) : net;
        }
        const net = gross.minus(absDiscount);
        return net.lt(0) ? new Big(0) : net;
    }

    /**
     * Склад-донор для отгрузки: берём stock_source_warehouse_id из строки заказа (в т.ч. markdown / 2 сорт).
     * Только если в строке NULL — подставляем finished (исторические данные).
     */
    function resolveStockDonorWarehouseId(stockSourceWarehouseId, finishedWarehouseId) {
        const w = Number(stockSourceWarehouseId);
        if (Number.isInteger(w) && w > 0) return w;
        return finishedWarehouseId;
    }

    /** Приоритет: склад из запроса → default_warehouse_id номенклатуры → склад ГП. */
    function resolveOrderLineSourceWarehouseId(payloadWarehouseId, itemDefaultWarehouseId, finishedWarehouseId) {
        const raw = payloadWarehouseId != null && payloadWarehouseId !== '' ? Number(payloadWarehouseId) : NaN;
        if (Number.isFinite(raw) && raw > 0) return raw;
        const def = Number(itemDefaultWarehouseId);
        if (Number.isFinite(def) && def > 0) return def;
        return finishedWarehouseId;
    }

    /** После rollback резервов в PUT: донор из строки, иначе каталог, иначе ГП. */
    function resolveLineDonorForReapply(stockSourceWarehouseId, itemDefaultWarehouseId, finishedWarehouseId) {
        const w = Number(stockSourceWarehouseId);
        if (Number.isInteger(w) && w > 0) return w;
        return resolveOrderLineSourceWarehouseId(null, itemDefaultWarehouseId, finishedWarehouseId);
    }

    async function loadItemsDefaultWarehouseMap(client, itemIds) {
        const ids = [...new Set((itemIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
        if (ids.length === 0) return new Map();
        const res = await client.query(
            `SELECT id, default_warehouse_id FROM items WHERE id = ANY($1::int[])`,
            [ids]
        );
        const m = new Map();
        for (const row of res.rows) {
            const v = row.default_warehouse_id;
            m.set(Number(row.id), v != null ? Number(v) : null);
        }
        return m;
    }

    async function allocateFifoBatches(client, itemId, warehouseId, requiredQty) {
        const need = Number(new Big(requiredQty || 0).round(4));
        if (need <= 0) return [];

        const rowsRes = await client.query(
            `
            SELECT batch_id, COALESCE(SUM(quantity), 0) AS available
            FROM inventory_movements
            WHERE item_id = $1
              AND warehouse_id = $2
            GROUP BY batch_id
            HAVING COALESCE(SUM(quantity), 0) > 0
            ORDER BY MIN(COALESCE(movement_date, created_at)) ASC, batch_id ASC
            `,
            [itemId, warehouseId]
        );

        let remaining = need;
        const plan = [];
        for (const row of rowsRes.rows) {
            if (remaining <= 0) break;
            const available = Number(new Big(row.available || 0).round(4));
            if (available <= 0) continue;
            const qty = Number(new Big(Math.min(remaining, available)).round(4));
            if (qty <= 0) continue;
            plan.push({ batch_id: row.batch_id, qty });
            remaining = Number(new Big(remaining).minus(qty).round(4));
        }

        if (remaining > 0.0001) {
            throw new Error(
                `Недостаточно товара для FIFO-списания: item_id=${itemId}, warehouse_id=${warehouseId}, требуется=${need}, нехватка=${remaining.toFixed(4)}`
            );
        }
        return plan;
    }

    // recalcAccountBalances импортирован из utils/accountBalances.js

    async function getPreferredAdvanceAccountId(client, counterpartyId) {
        if (!counterpartyId) return null;
        const q = await client.query(
            `
            SELECT t.account_id, SUM(t.amount) AS total
            FROM transactions t
            WHERE t.counterparty_id = $1
              AND t.transaction_type = 'income'
              AND COALESCE(t.is_deleted, false) = false
              AND t.linked_order_id IS NULL
              AND t.account_id IS NOT NULL
              AND COALESCE(t.payment_method, '') <> 'Взаимозачет'
            GROUP BY t.account_id
            ORDER BY SUM(t.amount) DESC, t.account_id ASC
            LIMIT 1
        `,
            [counterpartyId]
        );
        return q.rows.length ? Number(q.rows[0].account_id) : null;
    }

    /**
     * DRY-хелпер: Баланс контрагента (5 компонентов).
     * Используется: checkout, apply-advance, /counterparties/:id/balance.
     * Делегирует в shared-утилиту utils/counterpartyBalance.js.
     * @param {object} dbClient — pool или client (внутри транзакции)
     * @param {number|string} cpId — ID контрагента
     * @returns {{ realBalance: Big, totalAdvance: Big, freeAdvance: Big, raw: object, isEmployee: boolean }}
     */
    // ↑ getCounterpartyBalance импортирован из utils/counterpartyBalance.js (строка 17)

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

                // 3. ВОССТАНОВЛЕНО: Финансовая проводка взаимозачета для целостности главной книги.
                // payment_method = 'Взаимозачет' — маркер технической операции.
                // Акт сверки фильтрует эти проводки во избежание задвоения.
                await client.query(`
                    INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, linked_order_id, transaction_date)
                    VALUES ($1, 'income', 'Взаимозачет аванса', $2, 'Взаимозачет', NULL, $3, $4, NOW())
                `, [amountStr, `Взаимозачет по заказу ${docNum}`, cpId, orderId]);

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
                const returnDefaultWhMap = await loadItemsDefaultWarehouseMap(client, (items || []).map((it) => it.id));
                if (items && items.length > 0) {
                    for (let item of items) {
                        if (new Big(item.qty || 0).lte(0)) throw new Error(`Количество возвращаемого товара должно быть больше нуля!`);
                        const whId = resolveOrderLineSourceWarehouseId(
                            item.warehouse_id,
                            returnDefaultWhMap.get(Number(item.id)),
                            defaultFinishedWhId
                        );
                        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id) VALUES ($1, $2, 'customer_return', $3, $4, $5)`, [item.id, item.qty, desc, whId, user_id || null]);
                        await client.query(`INSERT INTO customer_return_items (return_id, item_id, quantity, price, warehouse_id) VALUES ($1, $2, $3, $4, $5)`, [returnId, item.id, item.qty, item.price, whId]);
                    }
                }

                // 🔗 Привязка к заказу: корректируем qty_shipped / qty_returned в позициях заказа.
                // Физический приход товара — только одно движение customer_return на склад из UI (цикл выше).
                if (order_id && items && items.length > 0) {
                    for (let item of items) {
                        const returnQty = parseFloat(item.qty) || 0;
                        const coiRes = await client.query(
                            `SELECT id, qty_shipped FROM client_order_items WHERE order_id = $1 AND item_id = $2 LIMIT 1`,
                            [order_id, item.id]
                        );
                        if (coiRes.rows.length > 0) {
                            const coi = coiRes.rows[0];
                            const currentShipped = parseFloat(coi.qty_shipped) || 0;
                            if (currentShipped > 0) {
                                const deduct = Math.min(returnQty, currentShipped);
                                await client.query(
                                    `UPDATE client_order_items SET qty_shipped = GREATEST(qty_shipped - $1, 0), qty_returned = COALESCE(qty_returned, 0) + $1 WHERE id = $2`,
                                    [deduct, coi.id]
                                );
                            }
                        }
                    }

                    await client.query(`UPDATE client_orders SET has_returns = true WHERE id = $1`, [order_id]);

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
                        await client.query(
                            `INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, user_id, linked_order_id, source_module)
                             VALUES ($1, 'expense', 'Возврат средств покупателю', $2, $3, 'Сразу', $4, $5, $6, $7, 'sales')`,
                            [refundAmountNum, desc, vatAmount, account_id, counterparty_id, user_id || null, order_id || null]
                        );

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
                                SET total_amount = GREATEST(total_amount - $1, 0),
                                    pending_debt = GREATEST(pending_debt - $1, 0)
                                WHERE id = $2
                            `, [refundAmountNum, order_id]);
                        }
                        // Строка в «Финансовой истории» контрагента: уменьшение долга без выдачи наличных
                        await client.query(
                            `INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, user_id, linked_order_id, source_module)
                             VALUES ($1, 'income', 'Возврат: компенсация долга', $2, 'Сразу', NULL, $3, $4, $5, 'sales')`,
                            [refundAmountNum, desc, counterparty_id, user_id || null, order_id || null]
                        );
                    }
                }
            });

            const itemsArr = Array.isArray(items) ? items : [];
            const refundAmtLog = Number(new Big(refund_amount || 0).round(2));
            const posStr = itemsArr.length
                ? itemsArr.map((it) => `item ${it.id}: ${it.qty} × ${it.price} ₽ (склад ${it.warehouse_id || '—'})`).join('; ')
                : 'без товарных позиций (возможны только поддоны/сумма)';
            const auditMsg = `Возврат по заказу #${order_id || '—'}; документ ${docNum}; суммы: ${refundAmtLog} ₽ (${refund_method || '—'}); поддоны: ${parseInt(String(pallets_returned || 0), 10) || 0}; позиции: ${posStr}${reason ? `; причина: ${reason}` : ''}`;
            await auditLog(pool, req, 'sales_return', 'client_order', order_id ? Number(order_id) : null, auditMsg);
            logger.info(`[sales_return] ${auditMsg}`);

            const io = req.app.get('io');
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            sendNotify(`♻️ <b>Возврат товара: ${escapeHtml(docNum)}</b>\nСумма: ${formatMoney(refund_amount || 0)} ₽\nПричина: ${escapeHtml(reason || 'Не указана')}`);

            res.json({ success: true, docNum, message: 'Возврат оформлен' });
        } catch (err) {
            logger.error(
                `POST /api/sales/returns: ${err.message} (pg_code=${err.code || 'n/a'}, detail=${err.detail || 'n/a'}, constraint=${err.constraint || 'n/a'})`
            );
            if (err.stack) logger.error(err.stack);
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

            const safeCounterpartyId = parseInt(String(counterparty_id), 10);
            if (!Number.isFinite(safeCounterpartyId) || safeCounterpartyId <= 0) {
                return res.status(400).json({ error: 'Не выбран корректный контрагент' });
            }

            await withTransaction(pool, async (client) => {
                const cpExistsRes = await client.query(
                    `SELECT id FROM counterparties WHERE id = $1 AND COALESCE(is_deleted, false) = false`,
                    [safeCounterpartyId]
                );
                if (!cpExistsRes.rows.length) {
                    throw new Error('Контрагент не найден');
                }

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
                
                const { realBalance, freeAdvance: availableAdvanceBig } = await getCounterpartyBalance(client, safeCounterpartyId);
                const availableAdvance = availableAdvanceBig;

                const requestedOffset = new Big(Number(offset_amount) || 0).lt(0) ? new Big(0) : new Big(Number(offset_amount) || 0);
                const _finalAmountBig = new Big(finalAmount);
                validatedOffset = Number(requestedOffset.lt(availableAdvance) ? requestedOffset : availableAdvance) > Number(_finalAmountBig) ? Number(_finalAmountBig) : Math.min(Number(requestedOffset.lt(availableAdvance) ? requestedOffset : availableAdvance), Number(_finalAmountBig));
                if (requestedOffset > 0 && validatedOffset + 0.01 < requestedOffset) {
                    logger.warn(`Запрошен зачет ${requestedOffset}, применено ${validatedOffset} (лимит свободного аванса/суммы заказа).`);
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

                const orderAuthorId = req.user ? req.user.id : null;
                const orderRes = await client.query(`
                    INSERT INTO client_orders (
                        counterparty_id, doc_number, status, total_amount, paid_amount, pending_debt,
                        payment_method, account_id, discount, planned_shipment_date, delivery_address, 
                        logistics_cost, pallets_qty, driver_name, auto_number, contract_info, contract_id, specification_id, created_at, user_id
                    ) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id
                `, [safeCounterpartyId, docNum, finalAmount, advanceAmt, pendingDebt, payment_method, account_id || null, discount, planned_shipment_date || null, delivery_address, logistics_cost, pallets_qty, driver, auto, contract_info, contract_id || null, specId, finalOrderDate, orderAuthorId]);

                const orderId = orderRes.rows[0].id;
                const reserveWhId = await getWhId(client, 'reserve');
                const defaultFinishedWhId = await getWhId(client, 'finished');
                const defaultWarehouseByItem = await loadItemsDefaultWarehouseMap(client, items.map((it) => it.id));

                for (let item of items) {
                    await client.query(`SELECT id FROM items WHERE id = $1 FOR UPDATE`, [item.id]);
                    const whId = resolveOrderLineSourceWarehouseId(
                        item.warehouse_id,
                        defaultWarehouseByItem.get(Number(item.id)),
                        defaultFinishedWhId
                    );
                    await lockStockPair(client, item.id, whId, reserveWhId);
                    
                    // Сначала создаём позицию заказа, чтобы получить её ID
                    const itemRes = await client.query(`
                        INSERT INTO client_order_items (order_id, item_id, qty_ordered, qty_reserved, qty_production, price, stock_source_warehouse_id) 
                        VALUES ($1, $2, $3, 0, 0, $4, $5) RETURNING id
                    `, [orderId, item.id, item.qty, item.price, whId]);
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

                const cpMetaRes = await client.query(
                    `
                    SELECT c.id, c.name, c.employee_id, e.full_name AS employee_name
                    FROM counterparties c
                    LEFT JOIN employees e ON e.id = c.employee_id
                    WHERE c.id = $1
                `,
                    [safeCounterpartyId]
                );
                const cpMeta = cpMetaRes.rows[0] || {};
                const isEmployeeCounterparty = Boolean(cpMeta.employee_id);
                const preferredAdvanceAccountId = await getPreferredAdvanceAccountId(client, safeCounterpartyId);
                const resolvedAccountId = Number(account_id) || preferredAdvanceAccountId || null;

                // Финансы: разделяем "живые деньги" и "зачет" по сценарию
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

                if (txAmount > 0 && !resolvedAccountId) {
                    throw new Error('Не выбрана касса/банк для оплаты. Укажите счет и повторите оформление заказа.');
                }

                const saleIncomeAmount = txAmount;

                if (saleIncomeAmount > 0 && resolvedAccountId) {
                    await client.query(
                        `INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, user_id, linked_order_id, source_module, transaction_date) VALUES ($1, 'income', 'Продажа продукции', $2, 'Сразу', $3, $4, $5, $6, 'sales', $7)`,
                        [saleIncomeAmount, finDesc, resolvedAccountId, safeCounterpartyId, user_id || null, orderId, finalOrderDate]
                    );
                    notifyCounterpartyBalanceChange({
                        counterpartyName: cpMeta.name || `#${safeCounterpartyId}`,
                        amount: saleIncomeAmount,
                        transactionType: 'income',
                        operationType: 'Оплата по заказу',
                        description: finDesc,
                        transactionDate: finalOrderDate
                    });
                }

                if (isEmployeeCounterparty && validatedOffset > 0) {
                    const offsetIncomeDesc = `Оплата заказа ${docNum} взаимозачетом (в счет ЗП)`;
                    await client.query(
                        `INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, employee_id, salary_adjustment_id, user_id, linked_order_id, source_module, transaction_date)
                         VALUES ($1, 'income', 'Продажа продукции', $2, 'Взаимозачет', NULL, $3, $4, NULL, $5, $6, 'sales', $7)`,
                        [validatedOffset, offsetIncomeDesc, safeCounterpartyId, cpMeta.employee_id, user_id || null, orderId, finalOrderDate]
                    );
                    notifyCounterpartyBalanceChange({
                        counterpartyName: cpMeta.name || `#${safeCounterpartyId}`,
                        amount: validatedOffset,
                        transactionType: 'income',
                        operationType: 'Взаимозачёт по заказу',
                        description: offsetIncomeDesc,
                        transactionDate: finalOrderDate
                    });
                    const salaryDesc = `Выдача аванса (продукцией) по заказу ${docNum}`;
                    const advanceExpenseRes = await client.query(
                        `INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, employee_id, salary_adjustment_id, user_id, linked_order_id, source_module, system_type, transaction_date)
                         VALUES ($1, 'expense', 'Зарплата и Авансы', $2, 'Взаимозачет', NULL, $3, $4, NULL, $5, $6, 'sales', 'salary_payment', $7)
                         RETURNING id`,
                        [validatedOffset, salaryDesc, safeCounterpartyId, cpMeta.employee_id, user_id || null, orderId, finalOrderDate]
                    );
                    await client.query(
                        `INSERT INTO salary_payments (employee_id, amount, payment_date, payment_type, description, account_id, linked_transaction_id)
                         VALUES ($1, $2, $3, 'advance', $4, $5, $6)`,
                        [cpMeta.employee_id, validatedOffset, finalOrderDate.split('T')[0], `${salaryDesc} [продукцией] (${cpMeta.employee_name || cpMeta.name || 'Сотрудник'})`, null, advanceExpenseRes.rows[0].id]
                    );
                }

                if (saleIncomeAmount > 0 && resolvedAccountId) {
                    await recalcAccountBalances(client, [resolvedAccountId]);
                }
            });

            let checkoutCpName = '';
            try {
                const cpRow = await pool.query('SELECT name FROM counterparties WHERE id = $1', [safeCounterpartyId]);
                checkoutCpName = cpRow.rows[0]?.name || '';
            } catch (_) { /* ignore */ }
            sendNotify(
                `🛒 <b>Новый заказ: ${escapeHtml(docNum)}</b>\n` +
                `Клиент: ${escapeHtml(checkoutCpName || '—')}\n` +
                `Сумма заказа: <b>${formatMoney(finalAmount)}</b> ₽`,
                {
                    reply_markup: {
                        inline_keyboard: [[{ text: '📋 Заказы в работе', callback_data: NOTIFY_CB.ORDERS_OPEN }]]
                    }
                }
            );
            res.json({ success: true, docNum, totalAmount: finalAmount, deficitReport });

        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: mapDbError(err, err.message || 'Ошибка оформления заказа') });
        }
    });

    // ------------------------------------------------------------------
    // 4. Зачет Свободного Аванса в конкретный заказ
    // ------------------------------------------------------------------
    router.post('/api/sales/orders/:id/apply-advance', requireAdmin, async (req, res) => {
        const orderId = req.params.id;
        const reason = String((req.body || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину зачета аванса' });
        
        try {
            await withTransaction(pool, async (client) => {
                // 1. Получаем заказ с блокировкой
                const orderRes = await client.query('SELECT counterparty_id, pending_debt, status, paid_amount FROM client_orders WHERE id = $1 FOR UPDATE', [orderId]);
                if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                const order = orderRes.rows[0];

                if (order.status === 'completed' || order.status === 'cancelled') {
                    throw new Error('Нельзя изменять оплату у закрытого или отмененного заказа');
                }

                const pendingDebtBig = new Big(order.pending_debt || 0);
                if (pendingDebtBig.lte(0)) {
                    throw new Error('У этого заказа нет долга');
                }
                const pendingDebt = Number(pendingDebtBig);

                const counterpartyId = order.counterparty_id;

                // 2. Вычисляем Свободный Аванс
                const { freeAdvance } = await getCounterpartyBalance(client, counterpartyId);

                if (freeAdvance.lte(0)) {
                    throw new Error('У клиента нет свободного аванса для зачета (возможно, он уже зарезервирован под другие заказы)');
                }

                // 3. Зачитываем сумму
                const offsetAmount = freeAdvance.lt(pendingDebtBig) ? freeAdvance : pendingDebtBig;
                const offsetAmountStr = offsetAmount.toFixed(2);

                // 3a. Финансовая проводка взаимозачета для целостности главной книги.
                // payment_method = 'Взаимозачет' — маркер технической операции.
                // Акт сверки фильтрует эти проводки во избежание задвоения.
                await client.query(`
                    INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, linked_order_id, transaction_date)
                    VALUES ($1, 'income', 'Взаимозачет аванса', $2, 'Взаимозачет', NULL, $3, $4, NOW())
                `, [offsetAmountStr, `Зачет свободного аванса в заказ #${orderId}`, counterpartyId, orderId]);

                // 4. Обновляем заказ
                await client.query(`
                    UPDATE client_orders 
                    SET paid_amount = paid_amount + $1, 
                        pending_debt = GREATEST(pending_debt - $1, 0)
                    WHERE id = $2
                `, [offsetAmountStr, orderId]);
                
            });

            const io = req.app.get('io');
            if (io) { io.emit('sales_updated'); }
            await auditLog(pool, req, 'sales_apply_advance', 'client_order', Number(orderId), `reason=${reason}`);
            
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
        const finalShipDate = resolveShipmentMovementTimestamp(ship_date);

        try {
            let docNum;
            let allCompleted = true;
            let shipmentAmountTotal = 0;
            let shipmentClientName = '';

            await withTransaction(pool, async (client) => {
                const orderRes = await client.query(
                    `SELECT id, counterparty_id, doc_number
                     FROM client_orders
                     WHERE id = $1
                     FOR UPDATE`,
                    [orderId]
                );
                if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                const order = orderRes.rows[0];
                const cpNameRes = await client.query('SELECT name FROM counterparties WHERE id = $1', [order.counterparty_id]);
                shipmentClientName = cpNameRes.rows[0]?.name || '';
                const counterpartyId = Number(order.counterparty_id || 0);
                if (!counterpartyId) throw new Error('Для заказа не определен контрагент');

                docNum = await getNextDocNumber(client, 'УТ', 'inventory_movements', 'description');

                /** Epsilon: «полное закрытие заказа» и сравнение остатков к отгрузке (устойчивость к float / numeric). */
                const SHIP_COMPLETION_EPSILON = 0.001;

                const allCoiRes = await client.query(
                    `
                    SELECT id,
                           COALESCE(qty_ordered, 0)::numeric AS qty_ordered,
                           COALESCE(qty_shipped, 0)::numeric AS qty_shipped
                    FROM client_order_items
                    WHERE order_id = $1
                    FOR UPDATE
                    `,
                    [orderId]
                );
                const deltaByCoiId = new Map();
                for (const it of items_to_ship || []) {
                    const cid = Number(it.coi_id);
                    const q = Number(it.qty);
                    if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(q) || q <= 0) continue;
                    deltaByCoiId.set(cid, (deltaByCoiId.get(cid) || 0) + q);
                }
                let hasRemainingAfterThisShipment = false;
                for (const row of allCoiRes.rows) {
                    const cid = Number(row.id);
                    const ordered = new Big(String(row.qty_ordered ?? 0));
                    const shippedSoFar = new Big(String(row.qty_shipped ?? 0));
                    const delta = new Big(deltaByCoiId.get(cid) || 0);
                    const remainingAfter = ordered.minus(shippedSoFar).minus(delta);
                    if (remainingAfter.gt(SHIP_COMPLETION_EPSILON)) {
                        hasRemainingAfterThisShipment = true;
                        break;
                    }
                }
                const descPrefix = hasRemainingAfterThisShipment ? 'Частичная отгрузка по Заказу' : 'Полная отгрузка по Заказу';
                let desc = `${docNum} | ${descPrefix}`;
                if (driver || auto) desc += ` | Транспорт: ${auto || '-'} (Водитель: ${driver || '-'})`;
                if (poa_info) desc += ` | ${poa_info}`;
                let shippedQtyBig = new Big(0);
                let insertedShipmentsCount = 0;

                if (pallets && parseInt(pallets) > 0) {
                    desc += ` | Поддоны: ${pallets} шт.`;
                    await client.query(`UPDATE counterparties SET pallets_balance = COALESCE(pallets_balance, 0) + $1 WHERE id = $2`, [parseInt(pallets), counterpartyId]);
                }

                const orderMoneyRes = await client.query(
                    `SELECT discount, logistics_cost FROM client_orders WHERE id = $1`,
                    [orderId]
                );
                const orderDiscount = orderMoneyRes.rows[0]?.discount ?? 0;
                const orderLogistics = new Big(orderMoneyRes.rows[0]?.logistics_cost || 0);
                const goodsBaseRes = await client.query(
                    `SELECT COALESCE(SUM(COALESCE(qty_ordered, 0) * COALESCE(price, 0)), 0)::numeric AS goods_gross
                     FROM client_order_items WHERE order_id = $1`,
                    [orderId]
                );
                const goodsGrossOrder = new Big(String(goodsBaseRes.rows[0]?.goods_gross || '0'));
                let shipmentGross = new Big(0);

                const reserveWhId = await getWhId(client, 'reserve');
                const finishedWhId = await getWhId(client, 'finished');
                for (let item of items_to_ship) {
                    if (item.qty <= 0) continue;

                    // 🔒 ШАГ 1: Блокируем позицию заказа (Row-Level Lock)
                    const coiRes = await client.query(
                        `SELECT id, item_id, qty_ordered, COALESCE(qty_shipped, 0) as qty_shipped, unit_cost_snapshot,
                                stock_source_warehouse_id, price
                         FROM client_order_items WHERE id = $1 FOR UPDATE`,
                        [item.coi_id]
                    );
                    if (coiRes.rows.length === 0) {
                        throw new Error(`Позиция заказа #${item.coi_id} не найдена.`);
                    }
                    const coi = coiRes.rows[0];
                    const donorWhId = resolveStockDonorWarehouseId(coi.stock_source_warehouse_id, finishedWhId);
                    await lockStockPair(client, item.item_id, reserveWhId, donorWhId);

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
                        const shortfall = parseFloat(new Big(item.qty).minus(reserveBalance).toFixed(4));
                        
                        const donorStockRes = await client.query(
                            `SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`,
                            [item.item_id, donorWhId]
                        );
                        let donorBalance = parseFloat(donorStockRes.rows[0].balance);

                        if (donorBalance >= shortfall) {
                            // Автоматически переносим недостаток со склада-донора строки заказа (как при оформлении: warehouse корзины / ГП) в резерв.
                            // Пишем стандартными типами, чтобы отчеты и аудит не путались:
                            // - reserve_expense: списание со свободного склада (donorWhId)
                            // - reserve_receipt: приход в резерв
                            let transferFifo = [];
                            try {
                                transferFifo = await allocateFifoBatches(client, item.item_id, donorWhId, shortfall);
                            } catch (e) {
                                logger.warn(`FIFO fallback for transfer item ${item.item_id}: ${e.message}`);
                                transferFifo = [{ batch_id: null, qty: shortfall }];
                            }
                            for (const part of transferFifo) {
                                await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id, movement_date) VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))`, [item.item_id, -part.qty, `Авто-перевод в резерв при отгрузке`, donorWhId, part.batch_id, user_id || null, item.coi_id, finalShipDate]);
                                await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id, movement_date) VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))`, [item.item_id, part.qty, `Авто-добор из свободных остатков`, reserveWhId, part.batch_id, user_id || null, item.coi_id, finalShipDate]);
                            }
                            
                            // Также корректируем qty_reserved в client_order_items, и убираем из дефицита (qty_production)
                            await client.query(`UPDATE client_order_items SET qty_reserved = COALESCE(qty_reserved, 0) + $1, qty_production = GREATEST(COALESCE(qty_production, 0) - $1, 0) WHERE id = $2`, [shortfall, item.coi_id]);
                            await client.query(
                                `UPDATE planned_production
                                 SET quantity = GREATEST(COALESCE(quantity, 0) - $1, 0)
                                 WHERE order_item_id = $2`,
                                [shortfall, item.coi_id]
                            );
                            await client.query(
                                `DELETE FROM planned_production WHERE order_item_id = $1 AND quantity <= 0`,
                                [item.coi_id]
                            );

                            reserveBalance = reserveBalance + shortfall; // Теперь хватает
                        } else {
                            throw new Error(
                                `Недостаточно товара для отгрузки (позиция #${coi.id}). ` +
                                `Требуется: ${item.qty}, в резерве: ${reserveBalance}, на складе-доноре (${donorWhId}): ${donorBalance}.`
                            );
                        }
                    }

                    // ✅ Всё проверено — выполняем списание и обновление
                    let shipFifo = [];
                    try {
                        shipFifo = await allocateFifoBatches(client, item.item_id, reserveWhId, item.qty);
                    } catch (e) {
                        logger.warn(`FIFO fallback for shipment item ${item.item_id}: ${e.message}`);
                        shipFifo = [{ batch_id: null, qty: item.qty }];
                    }
                    let itemShippedBig = new Big(0);
                    for (const part of shipFifo) {
                        await client.query(
                            `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id, movement_date, shipment_doc_number)
                             VALUES ($1, $2, 'sales_shipment', $3, $4, $5, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP), $9)`,
                            [item.item_id, -part.qty, desc, reserveWhId, part.batch_id, user_id || null, item.coi_id, finalShipDate, docNum]
                        );
                        itemShippedBig = itemShippedBig.plus(new Big(part.qty || 0));
                        insertedShipmentsCount++;
                    }
                    shippedQtyBig = shippedQtyBig.plus(itemShippedBig);
                    shipmentGross = shipmentGross.plus(new Big(item.qty || 0).times(coi.price || 0));
                    await client.query(
                        `UPDATE client_order_items
                         SET qty_shipped = COALESCE(qty_shipped, 0) + $1,
                             qty_reserved = GREATEST(COALESCE(qty_reserved, 0) - $1, 0)
                         WHERE id = $2`,
                        [item.qty, item.coi_id]
                    );

                    // 📸 СЛЕПОК СЕБЕСТОИМОСТИ: фиксируем при первой отгрузке позиции
                    if (coi.unit_cost_snapshot == null) {
                        try {
                            const overheadRes = await client.query(`SELECT value FROM settings WHERE key = 'overhead_per_cycle'`);
                            const overheadPerCycle = overheadRes.rows.length > 0 ? Number(overheadRes.rows[0].value || 0) : 0;
                            const { unitCostMap } = await buildSalesAnalyticsUnitCostData(pool, [item.item_id], {
                                includeOverhead: true,
                                overheadPerCycle
                            });
                            const costInfo = unitCostMap.get(item.item_id) || { unit_cost: 0, source: 'none' };
                            await client.query(
                                `UPDATE client_order_items SET unit_cost_snapshot = $1, cost_source = $2 WHERE id = $3`,
                                [costInfo.unit_cost, costInfo.source, item.coi_id]
                            );
                        } catch (snapErr) {
                            logger.warn(`Не удалось зафиксировать себестоимость для COI #${item.coi_id}: ${snapErr.message}`);
                        }
                    }
                }

                if (insertedShipmentsCount === 0 || shippedQtyBig.lte(SHIP_COMPLETION_EPSILON)) {
                    throw new Error('Отгрузка прервана: не создано ни одного движения склада.');
                }

                let shipmentAmountBig = applySmartDiscount(shipmentGross, orderDiscount, goodsGrossOrder);
                if (orderLogistics.gt(0) && goodsGrossOrder.gt(0) && shipmentGross.gt(0)) {
                    shipmentAmountBig = shipmentAmountBig.plus(
                        orderLogistics.times(shipmentGross.div(goodsGrossOrder))
                    );
                }
                shipmentAmountTotal = Number(shipmentAmountBig.round(2));

                const remainingRes = await client.query(
                    `
                    SELECT COUNT(*)::int AS cnt
                    FROM client_order_items
                    WHERE order_id = $1
                      AND (COALESCE(qty_ordered, 0) - COALESCE(qty_shipped, 0)) > $2
                    `,
                    [orderId, SHIP_COMPLETION_EPSILON]
                );
                allCompleted = Number(remainingRes.rows[0]?.cnt || 0) === 0;

                if (allCompleted) {
                    await client.query(`UPDATE client_orders SET status = 'completed' WHERE id = $1`, [orderId]);
                } else {
                    await client.query(`UPDATE client_orders SET status = 'processing' WHERE id = $1 AND status = 'pending'`, [orderId]);
                }
            });
            const io = req.app.get('io');
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            sendNotify(
                `🚚 <b>Отгрузка: ${escapeHtml(docNum)}</b>\n` +
                `Клиент: ${escapeHtml(shipmentClientName || '—')}\n` +
                `Сумма отгрузки: <b>${formatMoney(shipmentAmountTotal)}</b> ₽\n` +
                `Машина уехала к клиенту.`
            );

            res.json({ success: true, docNum, isCompleted: allCompleted });
        } catch (err) {
            logger.error(err);
            const msg = mapDbError(err, err.message || 'Внутренняя ошибка сервера. Обратитесь к администратору.');
            res.status(msg.includes('Невозможно') || msg.includes('Недостаточно') || msg.includes('не найдена') || err.code === '23514' || err.code === 'P0001' ? 400 : 500)
               .json({ error: msg });
        }
    });

    // ------------------------------------------------------------------
    // 6. Отмена отгрузки (ИСПРАВЛЕНО: возврат товара в Резерв)
    // ------------------------------------------------------------------
    router.delete('/api/sales/shipments/:docNum', requireAdmin, async (req, res) => {
        const { docNum } = req.params;
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину отмены отгрузки' });

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
            await auditLog(pool, req, 'sales_shipment_delete', 'shipment', null, `doc=${docNum}; reason=${reason}`);
            res.json({ success: true, message: 'Отгрузка отменена, товар возвращён в резерв' });
        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 7. Предпросмотр и удаление заказа с режимами settlement_mode
    // ------------------------------------------------------------------
    router.get('/api/sales/orders/:id/delete-preview', requireAdmin, async (req, res) => {
        try {
            const orderId = Number(req.params.id);
            const preview = await withTransaction(pool, async (client) => {
                const snapshot = await getOrderSettlementSnapshot(client, orderId, { forUpdate: false });
                if (!snapshot) throw new Error('Заказ не найден');
                const rec = await reconcileOrderSettlement(client, orderId, { apply: false, forUpdate: false });
                return {
                    ...snapshot,
                    mismatch: rec?.mismatch || false,
                    targetPaidAmount: rec?.targetPaidAmount ?? snapshot.linkedIncome,
                    targetPendingDebt: rec?.targetPendingDebt ?? snapshot.effectivePending,
                    warning: snapshot.linkedIncome > 0 || snapshot.ghostPaid > 0
                        ? 'При удалении можно оставить сумму как свободный аванс контрагента (наш долг).'
                        : null
                };
            });
            res.json(preview);
        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    router.delete('/api/sales/orders/:id', requireAdmin, async (req, res) => {
        const reason = String((req.query || {}).reason || '').trim();
        const settlementMode = normalizeSettlementMode((req.query || {}).settlement_mode);
        const refundAmount = money((req.query || {}).refund_amount || 0);
        const confirmImbalance = String((req.query || {}).confirm_financial_imbalance || '').toLowerCase() === 'true';
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления заказа' });

        try {
            const result = await withTransaction(pool, async (client) => {
                const orderId = Number(req.params.id);
                const snapshot = await getOrderSettlementSnapshot(client, orderId, { forUpdate: true });
                if (!snapshot) throw new Error('Заказ не найден');

                if (snapshot.isLocked) {
                    throw new Error('Заказ защищен режимом Нотариус.');
                }
                if (snapshot.status === 'completed' || snapshot.status === 'cancelled') {
                    throw new Error('Нельзя удалить закрытый или отменённый заказ.');
                }

                const rec = await reconcileOrderSettlement(client, orderId, { apply: true, forUpdate: true });
                const linkedIncomeBefore = money(rec?.targetPaidAmount || snapshot.linkedIncome);
                const plan = planSettlementActions({
                    mode: settlementMode,
                    linkedIncome: linkedIncomeBefore,
                    refundAmount,
                    ghostPaid: snapshot.ghostPaid
                });
                if (plan.requiresExplicitConfirm && !confirmImbalance) {
                    throw new Error('Подтвердите удаление с финансовым дисбалансом (confirm_financial_imbalance=true).');
                }

                // Проверка отгрузок
                const realShipBalance = await client.query(
                    `SELECT COALESCE(SUM(CASE WHEN movement_type = 'sales_shipment' THEN ABS(quantity) ELSE 0 END), 0) as shipped,
                            COALESCE(SUM(CASE WHEN movement_type = 'shipment_reversal' THEN ABS(quantity) ELSE 0 END), 0) as reversed
                     FROM inventory_movements
                     WHERE linked_order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)
                       AND movement_type IN ('sales_shipment', 'shipment_reversal')`,
                    [orderId]
                );
                const netShipment = (parseFloat(realShipBalance.rows[0].shipped) || 0) - (parseFloat(realShipBalance.rows[0].reversed) || 0);
                if (netShipment > 0) {
                    const returnCheck = await client.query(
                        `SELECT COALESCE(SUM(ABS(quantity)), 0) as returned
                         FROM inventory_movements
                         WHERE movement_type = 'customer_return'
                           AND item_id IN (SELECT item_id FROM client_order_items WHERE order_id = $1)`,
                        [orderId]
                    );
                    const returnedQty = parseFloat(returnCheck.rows[0].returned) || 0;
                    if (returnedQty < netShipment) {
                        throw new Error(`Нельзя удалить. По заказу есть неотменённые отгрузки (${netShipment} ед.). Перейдите в "Архив отгрузок" и нажмите ❌.`);
                    }
                }

                // Самолечение по отгрузкам
                const shipCheck = await client.query(
                    `SELECT COALESCE(SUM(qty_shipped), 0) as total_shipped
                     FROM client_order_items WHERE order_id = $1`,
                    [orderId]
                );
                const bookShipped = parseFloat(shipCheck.rows[0].total_shipped) || 0;
                if (bookShipped > 0 || netShipment > 0) {
                    await client.query(
                        `DELETE FROM inventory_movements
                         WHERE movement_type IN ('sales_shipment', 'shipment_reversal')
                           AND linked_order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)`,
                        [orderId]
                    );
                    await client.query(`UPDATE client_order_items SET qty_shipped = 0 WHERE order_id = $1`, [orderId]);
                    await client.query(
                        `DELETE FROM inventory_movements
                         WHERE movement_type = 'customer_return'
                           AND item_id IN (SELECT item_id FROM client_order_items WHERE order_id = $1)
                           AND description LIKE '%' || $1 || '%'`,
                        [snapshot.docNumber]
                    );
                }

                // Возврат резерва
                const reserveMoves = await client.query(
                    `SELECT id
                     FROM inventory_movements
                     WHERE movement_type IN ('reserve_expense', 'reserve_receipt')
                       AND description LIKE $1`,
                    [`%Заказ (Резерв): ${snapshot.docNumber}%`]
                );
                for (const mv of reserveMoves.rows) {
                    await client.query('DELETE FROM inventory_movements WHERE id = $1', [mv.id]);
                }

                // Плановое производство
                await client.query(
                    `DELETE FROM planned_production WHERE order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)`,
                    [orderId]
                );

                // Settlement strategy
                const activeTxRes = await client.query(
                    `SELECT id, amount, account_id
                     FROM transactions
                     WHERE linked_order_id = $1
                       AND transaction_type = 'income'
                       AND COALESCE(is_deleted, false) = false
                     ORDER BY transaction_date DESC, id DESC`,
                    [orderId]
                );
                const activeTx = activeTxRes.rows;
                const touchedAccountIds = [];
                let deletedByRefund = 0;
                let unlinkedToAdvance = 0;
                let toRefund = plan.toRefund;

                for (const tx of activeTx) {
                    const txAmount = money(tx.amount);
                    if (toRefund > 0 && settlementMode !== SETTLEMENT_MODES.KEEP_ADVANCE) {
                        if (txAmount <= toRefund + 0.0001) {
                            await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [tx.id]);
                            touchedAccountIds.push(tx.account_id);
                            deletedByRefund = money(deletedByRefund + txAmount);
                            toRefund = money(toRefund - txAmount);
                            continue;
                        }
                    }
                    await client.query(
                        `UPDATE transactions
                         SET linked_order_id = NULL,
                             description = CASE
                                 WHEN POSITION($2 IN COALESCE(description, '')) > 0 THEN description
                                 ELSE COALESCE(description, '') || $2
                             END
                         WHERE id = $1`,
                        [tx.id, ` / аванс после удаления заказа ${snapshot.docNumber}`]
                    );
                    unlinkedToAdvance = money(unlinkedToAdvance + txAmount);
                }

                // Каскадная очистка salary-моста по заказу:
                // удаляем расходные операции аванса и связанные salary_adjustments.
                const bridgeExpenseRes = await client.query(
                    `SELECT id, account_id, salary_adjustment_id
                     FROM transactions
                     WHERE linked_order_id = $1
                       AND transaction_type = 'expense'
                       AND COALESCE(is_deleted, false) = false`,
                    [orderId]
                );
                const bridgeAdjustmentIds = [];
                const bridgeTxIds = [];
                for (const tx of bridgeExpenseRes.rows) {
                    await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [tx.id]);
                    if (tx.account_id) touchedAccountIds.push(tx.account_id);
                    if (tx.salary_adjustment_id) bridgeAdjustmentIds.push(Number(tx.salary_adjustment_id));
                    bridgeTxIds.push(Number(tx.id));
                }
                const uniqueTxIds = Array.from(new Set(bridgeTxIds.filter((v) => Number.isInteger(v) && v > 0)));
                if (uniqueTxIds.length > 0) {
                    await client.query(
                        `UPDATE salary_payments
                         SET is_deleted = true
                         WHERE linked_transaction_id = ANY($1::int[])
                           AND COALESCE(is_deleted, false) = false`,
                        [uniqueTxIds]
                    );
                }
                const uniqueAdjIds = Array.from(new Set(bridgeAdjustmentIds.filter((v) => Number.isInteger(v) && v > 0)));
                if (uniqueAdjIds.length > 0) {
                    await client.query(
                        `UPDATE salary_adjustments
                         SET is_deleted = true
                         WHERE id = ANY($1::int[])`,
                        [uniqueAdjIds]
                    );
                }

                if (toRefund > 0.0001) {
                    throw new Error(`Не удалось выполнить откат оплаты на ${toRefund} ₽. Повторите операцию.`);
                }

                await recalcAccountBalances(client, touchedAccountIds);

                // Удаление заказа
                await client.query('DELETE FROM client_order_items WHERE order_id = $1', [orderId]);
                await client.query('DELETE FROM client_orders WHERE id = $1', [orderId]);

                const numMatch = String(snapshot.docNumber || '').match(/\d+/);
                if (numMatch) {
                    const deletedNum = parseInt(numMatch[0], 10);
                    await client.query(
                        `UPDATE document_counters
                         SET last_number = last_number - 1
                         WHERE prefix = 'ЗК' AND last_number = $1`,
                        [deletedNum]
                    );
                }

                return {
                    docNumber: snapshot.docNumber,
                    settlementMode,
                    linkedIncomeBefore,
                    ghostPaid: snapshot.ghostPaid,
                    deletedByRefund,
                    unlinkedToAdvance
                };
            });

            const io = req.app.get('io');
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); io.emit('finance_updated'); }
            await auditLog(
                pool,
                req,
                'sales_order_delete',
                'client_order',
                Number(req.params.id),
                `reason=${reason}; mode=${result.settlementMode}; linkedIncome=${result.linkedIncomeBefore}; refunded=${result.deletedByRefund}; keptAdvance=${result.unlinkedToAdvance}; ghostPaid=${result.ghostPaid}`
            );
            res.json({
                success: true,
                message: result.unlinkedToAdvance > 0
                    ? 'Заказ удалён. Невозвращённая часть оставлена как свободный аванс контрагента.'
                    : 'Заказ удалён, резервы возвращены на склад.',
                settlement: result
            });
        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    router.post('/api/sales/reconcile-order-settlements', requireAdmin, async (req, res) => {
        const apply = Boolean((req.body || {}).apply);
        const orderIdsRaw = Array.isArray((req.body || {}).orderIds) ? req.body.orderIds : [];
        const orderIds = orderIdsRaw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
        try {
            const report = await withTransaction(pool, async (client) => {
                const targetOrderIds = orderIds.length
                    ? orderIds
                    : (await client.query(`SELECT id FROM client_orders WHERE status IN ('pending', 'processing', 'completed')`)).rows.map((r) => Number(r.id));
                const out = [];
                for (const orderId of targetOrderIds) {
                    const row = await reconcileOrderSettlement(client, orderId, { apply, forUpdate: apply });
                    if (!row) continue;
                    if (row.mismatch || apply) {
                        out.push({
                            orderId: row.orderId,
                            docNumber: row.docNumber,
                            paidAmount: row.paidAmount,
                            pendingDebt: row.pendingDebt,
                            linkedIncome: row.linkedIncome,
                            targetPaidAmount: row.targetPaidAmount,
                            targetPendingDebt: row.targetPendingDebt,
                            ghostPaid: row.ghostPaid,
                            mismatch: row.mismatch,
                            applied: row.applied
                        });
                    }
                }
                return out;
            });
            const io = req.app.get('io');
            if (io && apply) io.emit('sales_updated');
            res.json({
                success: true,
                mode: apply ? 'apply' : 'dry_run',
                count: report.length,
                report
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: err.message || 'Ошибка reconcile заказов' });
        }
    });
    // ------------------------------------------------------------------
    // Остальные маршруты (Analytics, Export, Status Update, etc.)
    // ------------------------------------------------------------------
    router.put('/api/sales/orders/:id/status', requireAdmin, validateOrderStatus, async (req, res) => {
        const orderId = req.params.id;
        const { status } = req.body;
        try {
            await withTransaction(pool, async (client) => {
                const checkRes = await client.query('SELECT is_locked, status AS current_status FROM client_orders WHERE id = $1 FOR UPDATE', [orderId]);
                if (checkRes.rows.length === 0) throw new Error('Заказ не найден');
                if (checkRes.rows[0].is_locked === true) {
                    throw new Error('Заказ защищен режимом "Нотариус" (опечатан). Изменение статуса запрещено.');
                }

                // ── Высвобождение резервов при отмене ──
                if (status === 'cancelled') {
                    // 1. Получаем все ID позиций заказа
                    const coiRes = await client.query(
                        'SELECT id FROM client_order_items WHERE order_id = $1',
                        [orderId]
                    );
                    const coiIds = coiRes.rows.map(r => r.id);

                    if (coiIds.length > 0) {
                        // 2. Удаляем физические движения резерва по надёжной FK-связи
                        await client.query(
                            `DELETE FROM inventory_movements
                             WHERE linked_order_item_id = ANY($1::int[])
                               AND movement_type IN ('reserve_expense', 'reserve_receipt')`,
                            [coiIds]
                        );

                        // 3. Обнуляем счётчики резерва и планового производства
                        await client.query(
                            `UPDATE client_order_items
                             SET qty_reserved = 0, qty_production = 0
                             WHERE order_id = $1`,
                            [orderId]
                        );

                        // 4. Удаляем плановое производство
                        await client.query(
                            `DELETE FROM planned_production
                             WHERE order_item_id = ANY($1::int[])`,
                            [coiIds]
                        );
                    }
                }

                await client.query('UPDATE client_orders SET status = $1 WHERE id = $2', [status, orderId]);
            });

            const io = req.app.get('io');
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); }
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            const code = err.message.includes('Нотариус') ? 403 : (err.message.includes('не найден') ? 404 : 500);
            res.status(code).json({ error: err.message || 'Внутренняя ошибка сервера.' });
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

                // 1. Высвобождаем зависшие резервы с созданием компенсирующих движений
                const finishedWhId = await getWhId(client, 'finished');
                const reserveWhId = await getWhId(client, 'reserve');
                const docNumber = order.doc_number || `#${orderId}`;

                const reservedItems = await client.query(
                    'SELECT id, item_id, qty_reserved, qty_ordered, COALESCE(qty_shipped, 0) as qty_shipped FROM client_order_items WHERE order_id = $1',
                    [orderId]
                );

                let totalNewOrdered = new Big(0);

                for (const coi of reservedItems.rows) {
                    const qty = parseFloat(coi.qty_reserved);
                    if (qty > 0.0001) {
                        await lockStockPair(client, coi.item_id, reserveWhId, finishedWhId);
                        let fifo = [];
                        try {
                            fifo = await allocateFifoBatches(client, coi.item_id, reserveWhId, qty);
                        } catch (e) {
                            logger.warn(`FIFO fallback for force-close item ${coi.item_id}: ${e.message}`);
                            fifo = [{ batch_id: null, qty }];
                        }
                        // Возвращаем со склада резерва → склад ГП
                        for (const part of fifo) {
                            await client.query(
                                `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id)
                                 VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6, $7)`,
                                [coi.item_id, -part.qty, `Возврат резерва (force-close): ${docNumber}`, reserveWhId, part.batch_id, req.user.id || null, coi.id]
                            );
                            await client.query(
                                `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id)
                                 VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6, $7)`,
                                [coi.item_id, part.qty, `Возврат резерва (force-close): ${docNumber}`, finishedWhId, part.batch_id, req.user.id || null, coi.id]
                            );
                        }
                    }

                    // 2. Отрезаем хвост: qty_ordered = qty_shipped
                    const shipped = parseFloat(coi.qty_shipped);
                    totalNewOrdered = totalNewOrdered.plus(shipped);
                    
                    await client.query(
                        'UPDATE client_order_items SET qty_ordered = $1, qty_reserved = 0, qty_production = 0 WHERE id = $2',
                        [shipped, coi.id]
                    );
                }

                // Удаляем плановое производство
                const coiIds = reservedItems.rows.map(r => r.id);
                if (coiIds.length > 0) {
                    await client.query(
                        'DELETE FROM planned_production WHERE order_item_id = ANY($1::int[])',
                        [coiIds]
                    );
                }

                // 3. Пересчитываем ИТОГОВУЮ СУММУ ЗАКАЗА (total_amount)
                const itemsRes = await client.query('SELECT qty_ordered, price FROM client_order_items WHERE order_id = $1', [orderId]);
                let newTotalBig = new Big(0);
                itemsRes.rows.forEach(i => {
                    newTotalBig = newTotalBig.plus(new Big(i.qty_ordered).times(i.price));
                });

                newTotalBig = applySmartDiscount(newTotalBig, order.discount || 0);

                // Прибавляем логистику, если есть
                newTotalBig = newTotalBig.plus(new Big(order.logistics_cost || 0));
                const newTotal = Number(newTotalBig.toFixed(2));

                // 4. Пересчитываем долг
                const paid = new Big(order.paid_amount || 0);
                const newDebtBig = newTotalBig.minus(paid);
                const newDebt = Number((newDebtBig.lt(0) ? new Big(0) : newDebtBig).toFixed(2));

                // 5. Обновляем статус заказа
                const newStatus = totalNewOrdered.lte(0.0001) ? 'cancelled' : 'completed';

                await client.query(`
                    UPDATE client_orders 
                    SET status = $1, 
                        total_amount = $2, 
                        pending_debt = $3 
                    WHERE id = $4
                `, [newStatus, newTotal, newDebt, orderId]);
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
        const {
            items,
            counterparty_id,
            discount,
            created_at,
            order_date,
            logistics_cost,
            delivery_address,
            comment,
            specification_id,
            payment_method,
            advance_amount,
            offset_amount,
            account_id
        } = req.body;
        
        try {
            await withTransaction(pool, async (client) => {
                const toSafeNumber = (value, fallback = 0) => {
                    if (value === null || value === undefined) return fallback;
                    const normalized = String(value).replace(/["']/g, '').replace(',', '.').trim();
                    if (normalized === '') return fallback;
                    const parsed = Number.parseFloat(normalized);
                    return Number.isFinite(parsed) ? parsed : fallback;
                };
                const toSafeInt = (value, fallback = null) => {
                    if (value === null || value === undefined) return fallback;
                    const normalized = String(value).replace(/["']/g, '').trim();
                    if (!normalized) return fallback;
                    const parsed = Number.parseInt(normalized, 10);
                    return Number.isFinite(parsed) ? parsed : fallback;
                };
                const safeCounterpartyId = toSafeInt(counterparty_id, null);
                const safeDiscount = toSafeNumber(discount, 0);
                const safeLogistics = toSafeNumber(logistics_cost, 0);
                const safeSpecificationId = toSafeInt(specification_id, null);
                const safeAdvanceAmount = Math.max(0, toSafeNumber(advance_amount, 0));
                const safeOffsetRequested = Math.max(0, toSafeNumber(offset_amount, 0));
                const safeAccountId = toSafeInt(account_id, null);
                if (!safeCounterpartyId) throw new Error('Не выбран корректный контрагент');

                const checkRes = await client.query('SELECT * FROM client_orders WHERE id = $1 FOR UPDATE', [orderId]);
                if (checkRes.rows.length === 0) throw new Error('Заказ не найден');
                const order = checkRes.rows[0];
                const safePaymentMethod = String(payment_method || '').trim() || String(order.payment_method || 'debt').trim();
                
                if (order.status === 'completed' || order.status === 'cancelled') {
                    throw new Error('Нельзя редактировать закрытый или отмененный заказ');
                }
                if (order.is_locked) throw new Error('Заказ опечатан нотариусом');
                if (!items || !Array.isArray(items)) throw new Error('Некорректный формат позиций заказа');

                // Блокируем позиции заказа в транзакции.
                const currentItemsRes = await client.query('SELECT * FROM client_order_items WHERE order_id = $1 FOR UPDATE', [orderId]);
                const currentItems = currentItemsRes.rows;

                // Получаем ID складов один раз для всех операций
                const finishedWhId = await getWhId(client, 'finished');
                const reserveWhId = await getWhId(client, 'reserve');
                const docNumber = order.doc_number || `#${orderId}`;

                // 1) Rollback резервов по текущей версии заказа:
                // удаляем старые движения reserve_* и обнуляем счетчики.
                const currentOrderItemIds = currentItems.map((r) => Number(r.id)).filter(Boolean);
                if (currentOrderItemIds.length > 0) {
                    await client.query(
                        `DELETE FROM inventory_movements
                         WHERE linked_order_item_id = ANY($1::int[])
                           AND movement_type IN ('reserve_expense', 'reserve_receipt')`,
                        [currentOrderItemIds]
                    );
                    await client.query(
                        `UPDATE client_order_items
                         SET qty_reserved = 0, qty_production = 0
                         WHERE id = ANY($1::int[])`,
                        [currentOrderItemIds]
                    );
                }

                // 2) Reapply: обновляем/добавляем позиции и накладываем резервы заново.
                let calculatedTotal = 0;
                const normalizedItems = [];
                for (const raw of items) {
                    const itemId = Number.parseInt(String(raw.id || '').replace(/"/g, '').trim(), 10);
                    const qty = toSafeNumber(raw.qty, 0);
                    const price = toSafeNumber(raw.price, 0);
                    if (!Number.isFinite(itemId) || !Number.isFinite(qty) || !Number.isFinite(price)) continue;
                    if (qty <= 0) continue;
                    normalizedItems.push({ id: itemId, qty, price });
                }

                if (normalizedItems.length === 0) {
                    throw new Error('Заказ должен содержать хотя бы одну позицию с количеством > 0');
                }

                const defaultWarehouseByItem = await loadItemsDefaultWarehouseMap(client, normalizedItems.map((x) => x.id));

                for (const newItem of normalizedItems) {
                    const itemId = newItem.id;
                    const newQty = newItem.qty;
                    const price = newItem.price;

                    const existingRow = currentItems.find((i) => parseInt(i.item_id, 10) === itemId);
                    const donorWhId = existingRow
                        ? resolveLineDonorForReapply(
                              existingRow.stock_source_warehouse_id,
                              defaultWarehouseByItem.get(itemId),
                              finishedWhId
                          )
                        : resolveOrderLineSourceWarehouseId(null, defaultWarehouseByItem.get(itemId), finishedWhId);

                    await lockStockPair(client, itemId, donorWhId, reserveWhId);

                    calculatedTotal += (newQty * price);

                    if (existingRow) {
                        // Товар уже был в заказе: не даем опустить qty ниже уже отгруженного.
                        const shipped = parseFloat(existingRow.qty_shipped || 0);
                        if (newQty < shipped) {
                            throw new Error(`Нельзя уменьшить кол-во ниже уже отгруженного (${shipped})`);
                        }

                        const needReserve = Math.max(newQty - shipped, 0);
                        const stockRes = await client.query(
                            `
                            SELECT COALESCE(SUM(quantity),0) AS q
                            FROM inventory_movements
                            WHERE item_id = $1 AND warehouse_id = $2
                            `,
                            [itemId, donorWhId]
                        );
                        const physicalQty = parseFloat(stockRes.rows[0]?.q || 0);

                        const totalReservedRes = await client.query(
                            `
                            SELECT COALESCE(SUM(qty_reserved),0) AS r
                            FROM client_order_items
                            WHERE item_id = $1 AND order_id <> $2
                            `,
                            [itemId, orderId]
                        );
                        const otherReserved = parseFloat(totalReservedRes.rows[0]?.r || 0);
                        const freeStock = Math.max(0, physicalQty - otherReserved);
                        const newReserved = Math.min(needReserve, freeStock);
                        const newProduction = Math.max(0, needReserve - newReserved);

                        if (newReserved > 0.0001) {
                            const reserveFifo = await allocateFifoBatches(client, itemId, donorWhId, newReserved);
                            for (const part of reserveFifo) {
                                await client.query(
                                    `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id)
                                     VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6, $7)`,
                                    [itemId, -part.qty, `Заказ (Резерв): ${docNumber}`, donorWhId, part.batch_id, req.user.id || null, existingRow.id]
                                );
                                await client.query(
                                    `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id)
                                     VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6, $7)`,
                                    [itemId, part.qty, `Заказ (Резерв): ${docNumber}`, reserveWhId, part.batch_id, req.user.id || null, existingRow.id]
                                );
                            }
                        }

                        await client.query(
                            `
                            UPDATE client_order_items
                            SET qty_ordered = $1,
                                price = $2,
                                qty_reserved = $3,
                                qty_production = $4,
                                stock_source_warehouse_id = $6
                            WHERE id = $5
                            `,
                            [newQty, price, newReserved, newProduction, existingRow.id, donorWhId]
                        );
                    } else {
                        // Новая позиция в заказе.
                        const stockRes = await client.query(
                            `
                            SELECT COALESCE(SUM(quantity),0) AS q
                            FROM inventory_movements
                            WHERE item_id = $1 AND warehouse_id = $2
                            `,
                            [itemId, donorWhId]
                        );
                        const physicalQty = parseFloat(stockRes.rows[0]?.q || 0);

                        const totalReservedRes = await client.query(
                            `
                            SELECT COALESCE(SUM(qty_reserved),0) AS r
                            FROM client_order_items
                            WHERE item_id = $1 AND order_id <> $2
                            `,
                            [itemId, orderId]
                        );
                        const otherReserved = parseFloat(totalReservedRes.rows[0]?.r || 0);
                        const freeStock = Math.max(0, physicalQty - otherReserved);
                        const reserve = Math.min(newQty, freeStock);
                        const productionNeed = Math.max(0, newQty - reserve);

                        const newCoiRes = await client.query(
                            `
                            INSERT INTO client_order_items (order_id, item_id, qty_ordered, qty_reserved, qty_production, price, qty_shipped, stock_source_warehouse_id)
                            VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
                            RETURNING id
                            `,
                            [orderId, itemId, newQty, reserve, productionNeed, price, donorWhId]
                        );

                        if (reserve > 0.0001) {
                            const newCoiId = newCoiRes.rows[0].id;
                            const reserveFifo = await allocateFifoBatches(client, itemId, donorWhId, reserve);
                            for (const part of reserveFifo) {
                                await client.query(
                                    `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id)
                                     VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6, $7)`,
                                    [itemId, -part.qty, `Заказ (Резерв): ${docNumber}`, donorWhId, part.batch_id, req.user.id || null, newCoiId]
                                );
                                await client.query(
                                    `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id)
                                     VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6, $7)`,
                                    [itemId, part.qty, `Заказ (Резерв): ${docNumber}`, reserveWhId, part.batch_id, req.user.id || null, newCoiId]
                                );
                            }
                        }
                    }
                }
                
                // 3) Удаляем позиции, которых больше нет в payload (если по ним нет отгрузки).
                const newIds = normalizedItems.map(i => parseInt(i.id, 10));
                for (let oldRow of currentItems) {
                    if (!newIds.includes(parseInt(oldRow.item_id))) {
                        const shipped = parseFloat(oldRow.qty_shipped || 0);
                        if (shipped > 0) throw new Error('Нельзя удалить из заказа товар, по которому уже была отгрузка.');
                        await client.query('DELETE FROM client_order_items WHERE id = $1', [oldRow.id]);
                    }
                }

                // 4) Плановое производство полностью пересобираем от фактического qty_production.
                await client.query(
                    `
                    DELETE FROM planned_production
                    WHERE order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)
                    `,
                    [orderId]
                );
                const productionRows = await client.query(
                    `
                    SELECT id, item_id, qty_production
                    FROM client_order_items
                    WHERE order_id = $1 AND qty_production > 0
                    `,
                    [orderId]
                );
                for (const row of productionRows.rows) {
                    await client.query(
                        `INSERT INTO planned_production (order_item_id, item_id, quantity) VALUES ($1, $2, $3)`,
                        [row.id, row.item_id, row.qty_production]
                    );
                }

                // 5) Перепривязка финансов при смене контрагента.
                const nextCounterpartyId = Number(safeCounterpartyId || 0);
                const currentCounterpartyId = Number(order.counterparty_id || 0);
                if (nextCounterpartyId && nextCounterpartyId !== currentCounterpartyId) {
                    const txRebindRes = await client.query(
                        `
                        UPDATE transactions
                        SET counterparty_id = $2
                        WHERE linked_order_id = $1
                          AND COALESCE(is_deleted, false) = false
                          AND (counterparty_id = $3 OR counterparty_id IS NULL)
                        `,
                        [orderId, nextCounterpartyId, currentCounterpartyId]
                    );

                    // Для целостной истории отгрузок явно привязываем движения отгрузки к order_id.
                    await client.query(
                        `
                        UPDATE inventory_movements
                        SET order_id = $1
                        WHERE linked_order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)
                          AND movement_type IN ('sales_shipment', 'shipment_reversal')
                        `,
                        [orderId]
                    );

                    logger.info(`[sales.edit] Rebound tx rows for order #${orderId}: ${txRebindRes.rowCount}`);
                }

                // 6) Пересчет итоговой суммы заказа.
                const parsedDiscount = new Big(safeDiscount || 0);
                const parsedLogistics = new Big(safeLogistics || 0);

                let calcTotalBig = applySmartDiscount(new Big(calculatedTotal), safeDiscount || 0);
                calcTotalBig = calcTotalBig.plus(parsedLogistics);
                calculatedTotal = Number(calcTotalBig.toFixed(2));

                // 6.1) Финансовый срез по уже существующим проводкам заказа.
                const paidNetRes = await client.query(
                    `
                    SELECT
                        COALESCE(SUM(CASE WHEN transaction_type = 'income'
                              AND TRIM(category) IS DISTINCT FROM 'Возврат: компенсация долга'
                              THEN amount ELSE 0 END), 0) AS income_total,
                        COALESCE(SUM(CASE WHEN transaction_type = 'expense' AND category = 'Возврат средств покупателю' THEN amount ELSE 0 END), 0) AS refund_total,
                        COALESCE(SUM(CASE WHEN transaction_type = 'income' AND TRIM(category) = 'Возврат: компенсация долга' THEN amount ELSE 0 END), 0) AS debt_comp_total
                    FROM transactions
                    WHERE linked_order_id = $1
                      AND COALESCE(is_deleted, false) = false
                    `,
                    [orderId]
                );
                const incomeTotal = new Big(toSafeNumber(paidNetRes.rows[0]?.income_total, 0));
                const refundTotal = new Big(toSafeNumber(paidNetRes.rows[0]?.refund_total, 0));
                const debtCompTotal = new Big(toSafeNumber(paidNetRes.rows[0]?.debt_comp_total, 0));
                const currentPaid = incomeTotal.minus(refundTotal).minus(debtCompTotal);
                const existingVirtualOffset = Math.max(
                    0,
                    toSafeNumber(order.paid_amount, 0) - Number(currentPaid.toFixed(2))
                );
                const effectivePaid = currentPaid.plus(new Big(existingVirtualOffset));

                if (calcTotalBig.lt(effectivePaid)) {
                    throw new Error('Сумма измененного заказа меньше уже внесенной оплаты. Оформите возврат средств клиенту отдельной финансовой операцией перед редактированием.');
                }

                let targetPaid = effectivePaid;
                if (safePaymentMethod === 'paid') {
                    targetPaid = calcTotalBig;
                } else if (safePaymentMethod === 'partial') {
                    targetPaid = effectivePaid.plus(new Big(safeAdvanceAmount));
                    if (targetPaid.gt(calcTotalBig)) targetPaid = calcTotalBig;
                } else if (safePaymentMethod === 'debt') {
                    targetPaid = effectivePaid;
                } else {
                    throw new Error('Некорректный способ оплаты при редактировании заказа.');
                }

                let delta = targetPaid.minus(effectivePaid);
                if (delta.lt(0)) {
                    throw new Error('Сумма измененного заказа меньше уже внесенной оплаты. Оформите возврат средств клиенту отдельной финансовой операцией перед редактированием.');
                }

                const cpMetaRes = await client.query(
                    `
                    SELECT c.id, c.name, c.employee_id, e.full_name AS employee_name
                    FROM counterparties c
                    LEFT JOIN employees e ON e.id = c.employee_id
                    WHERE c.id = $1
                `,
                    [safeCounterpartyId]
                );
                const cpMeta = cpMetaRes.rows[0] || {};
                let offsetApplied = new Big(0);
                if (safeOffsetRequested > 0 && delta.gt(0)) {
                    const { freeAdvance } = await getCounterpartyBalance(client, safeCounterpartyId);
                    const effectiveFreeAdvance = freeAdvance.plus(new Big(existingVirtualOffset));
                    offsetApplied = new Big(safeOffsetRequested);
                    if (offsetApplied.gt(delta)) offsetApplied = delta;
                    if (offsetApplied.gt(effectiveFreeAdvance)) {
                        if (effectiveFreeAdvance.lte(0)) {
                            throw new Error('У клиента нет свободного аванса для зачета (возможно, он уже зарезервирован под другие заказы)');
                        }
                        logger.warn(
                            `[sales.edit] Запрошен зачет ${safeOffsetRequested} по заказу ${docNumber}, применено ${effectiveFreeAdvance.toFixed(2)} (лимит свободного аванса с учётом зачёта этого заказа).`
                        );
                        offsetApplied = effectiveFreeAdvance;
                    }
                }
                const incomeDelta = delta.minus(offsetApplied);

                const touchedAccountIds = [];
                if (incomeDelta.gt(0)) {
                    const accountForIncome = safeAccountId || toSafeInt(order.account_id, null);
                    if (!accountForIncome) {
                        throw new Error('Для доплаты при редактировании укажите кассу/банк.');
                    }
                    await client.query(
                        `INSERT INTO transactions
                            (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, user_id, linked_order_id, source_module, transaction_date)
                         VALUES
                            ($1, 'income', 'Продажа продукции', $2, 'Сразу', $3, $4, $5, $6, 'sales', NOW())`,
                        [Number(incomeDelta.toFixed(2)), `Доплата по заказу ${docNumber} (редактирование)`, accountForIncome, safeCounterpartyId, req.user?.id || null, orderId]
                    );
                    touchedAccountIds.push(accountForIncome);
                }

                if (offsetApplied.gt(0)) {
                    const offsetAmountStr = offsetApplied.toFixed(2);
                    await client.query(
                        `
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, linked_order_id, source_module, transaction_date)
                        VALUES ($1, 'income', 'Взаимозачет аванса', $2, 'Взаимозачет', NULL, $3, $4, 'sales', NOW())
                        `,
                        [offsetAmountStr, `Зачет аванса по заказу ${docNumber} (редактирование)`, safeCounterpartyId, orderId]
                    );
                    notifyCounterpartyBalanceChange({
                        counterpartyName: cpMeta.name || `#${safeCounterpartyId}`,
                        amount: Number(offsetAmountStr),
                        transactionType: 'income',
                        operationType: 'Взаимозачёт по заказу (редактирование)',
                        description: `Зачет аванса по заказу ${docNumber} (редактирование)`,
                        transactionDate: new Date()
                    });
                }

                if (touchedAccountIds.length > 0) {
                    await recalcAccountBalances(client, touchedAccountIds);
                }

                const finalPaid = effectivePaid.plus(incomeDelta).plus(offsetApplied);
                const safePaidAmount = toSafeNumber(finalPaid.toFixed(2), 0);
                const newDebtBig2 = calcTotalBig.minus(finalPaid);
                const safePendingDebt = toSafeNumber((newDebtBig2.lt(0) ? new Big(0) : newDebtBig2).toFixed(2), 0);
                const safeTotalAmount = toSafeNumber(calculatedTotal, 0);
                const safeDiscountForSql = toSafeNumber(parsedDiscount.toFixed(2), 0);
                const safeLogisticsForSql = toSafeNumber(parsedLogistics.toFixed(2), 0);
                
                // Прописываем новую дату. Важно - дата может быть просто YYYY-MM-DD
                let dateQueryAdd = '';
                let dbParams = [
                    safeCounterpartyId, safeTotalAmount, safePaidAmount, safePendingDebt, safeDiscountForSql,
                    safeLogisticsForSql, delivery_address || '', comment || '',
                    safeSpecificationId, orderId
                ];
                
                const effectiveOrderDate = (created_at && String(created_at).trim() !== '')
                    ? String(created_at).trim()
                    : ((order_date && String(order_date).trim() !== '') ? String(order_date).trim() : '');
                if (effectiveOrderDate) {
                    // Если дата передана - обновляем
                    dateQueryAdd = ', created_at = $11';
                    dbParams.push(effectiveOrderDate);
                }
                
                // 7) Запись обновлений в шапку заказа.
                await client.query(`
                    UPDATE client_orders
                    SET counterparty_id = $1, 
                        total_amount = $2, 
                        paid_amount = $3,
                        pending_debt = $4, 
                        discount = $5,
                        logistics_cost = $6,
                        delivery_address = $7,
                        contract_info = $8,
                        specification_id = $9
                        ${dateQueryAdd}
                    WHERE id = $10
                `, dbParams);

                // Синхронизируем дату только для "стартовых" проводок, созданных в момент оформления заказа:
                // - Продажа продукции (живые деньги в кассу)
                // - Зарплата и Авансы (выдача аванса продукцией сотруднику)
                // Не трогаем последующие оплаты/взаимозачеты, чтобы не искажать хронологию фактических действий.
                if (effectiveOrderDate) {
                    await client.query(`
                        UPDATE transactions
                        SET transaction_date = $2
                        WHERE linked_order_id = $1
                          AND (
                                (source_module = 'sales' AND category IN ('Продажа продукции', 'Зарплата и Авансы'))
                                OR (source_module IS NULL AND category = 'Продажа продукции' AND payment_method = 'Сразу')
                                OR (source_module = 'manual' AND category = 'Продажа продукции' AND description LIKE 'Заказ %')
                              )
                    `, [orderId, effectiveOrderDate]);
                }
            });

            const io = req.app.get('io');
            if (io) { io.emit('inventory_updated'); io.emit('sales_updated'); io.emit('finance_updated'); }
            res.json({ success: true, message: 'Заказ успешно отредактирован!' });
            
        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: mapDbError(err, err.message || 'Ошибка редактирования заказа') });
        }
    });


    // ------------------------------------------------------------------
    // ПОЛУЧЕНИЕ ЗАКАЗОВ КЛИЕНТА ДЛЯ ВОЗВРАТА
    // ------------------------------------------------------------------
    router.get('/api/sales/client-orders/:clientId', async (req, res) => {
        try {
            const clientId = req.params.clientId;
            const result = await pool.query(`
                SELECT id, doc_number, status, total_amount, created_at
                FROM client_orders
                WHERE counterparty_id = $1 AND COALESCE(is_deleted, false) = false
                ORDER BY created_at DESC
            `, [clientId]);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // ------------------------------------------------------------------
    // ЗАДАЧА №9: УМНЫЙ ПОИСК ЗАКАЗОВ (Авто, Водитель, Телефон, Имя)
    // ------------------------------------------------------------------
    router.get('/api/sales/orders', async (req, res) => {
        const { start, end, search } = req.query;

        try {
            // 🚀 EPIC-4 P1: CTE-оптимизация — 13 correlated subqueries → 7 CTE + LEFT JOIN
            let query = `
                WITH cp_completed AS (
                    SELECT counterparty_id, COALESCE(SUM(total_amount), 0) as total
                    FROM client_orders WHERE status = 'completed' AND COALESCE(is_deleted, false) = false
                    GROUP BY counterparty_id
                ),
                cp_tx_expense AS (
                    SELECT counterparty_id, COALESCE(SUM(amount), 0) as total
                    FROM transactions WHERE transaction_type = 'expense' AND COALESCE(is_deleted, false) = false
                    GROUP BY counterparty_id
                ),
                cp_tx_income AS (
                    SELECT counterparty_id, COALESCE(SUM(amount), 0) as total
                    FROM transactions WHERE transaction_type = 'income' AND COALESCE(is_deleted, false) = false
                    GROUP BY counterparty_id
                ),
                cp_purchases AS (
                    SELECT supplier_id as counterparty_id, COALESCE(SUM(amount), 0) as total
                    FROM inventory_movements WHERE movement_type = 'purchase'
                    GROUP BY supplier_id
                ),
                cp_pending_allocated AS (
                    SELECT counterparty_id, COALESCE(SUM(paid_amount), 0) as total
                    FROM client_orders WHERE status IN ('pending', 'processing') AND COALESCE(is_deleted, false) = false
                    GROUP BY counterparty_id
                ),
                cp_pending_debt AS (
                    SELECT counterparty_id, COALESCE(SUM(pending_debt), 0) as total
                    FROM client_orders WHERE status != 'cancelled' AND COALESCE(is_deleted, false) = false
                    GROUP BY counterparty_id
                ),
                order_items_agg AS (
                    SELECT
                        coi.order_id,
                        COALESCE(SUM(coi.qty_ordered), 0) as total_ordered,
                        COALESCE(SUM(coi.qty_shipped), 0) as total_shipped,
                        STRING_AGG(i.name || ' (' || coi.qty_ordered || ' ' || i.unit || ')', ', ') as items_list
                    FROM client_order_items coi
                    JOIN items i ON coi.item_id = i.id
                    GROUP BY coi.order_id
                )
                SELECT
                    o.*,
                    c.name as client_name,
                    TO_CHAR(o.created_at, 'DD.MM.YYYY HH24:MI') as date_formatted,
                    TO_CHAR(o.planned_shipment_date, 'DD.MM.YYYY') as deadline,
                    COALESCE(oia.items_list, 'Пусто') as items_list,
                    COALESCE(oia.total_ordered, 0) as total_ordered,
                    COALESCE(oia.total_shipped, 0) as total_shipped,
                    -- 💰 Реальный баланс контрагента (CTE)
                    (COALESCE(cpc.total, 0) + COALESCE(cpe.total, 0) - COALESCE(cpp.total, 0) - COALESCE(cpi.total, 0)) as client_balance,
                    -- Свободный аванс (CTE)
                    GREATEST(0, ABS(LEAST(0, (COALESCE(cpc.total, 0) + COALESCE(cpe.total, 0) - COALESCE(cpp.total, 0) - COALESCE(cpi.total, 0)))) - COALESCE(cpa.total, 0)) as free_advance,
                    -- Прогноз
                    COALESCE(cpd.total, 0) * -1 as projected_balance,
                    u_author.full_name as author_name
                FROM client_orders o
                LEFT JOIN counterparties c ON o.counterparty_id = c.id
                LEFT JOIN order_items_agg oia ON oia.order_id = o.id
                LEFT JOIN cp_completed cpc ON cpc.counterparty_id = o.counterparty_id
                LEFT JOIN cp_tx_expense cpe ON cpe.counterparty_id = o.counterparty_id
                LEFT JOIN cp_tx_income cpi ON cpi.counterparty_id = o.counterparty_id
                LEFT JOIN cp_purchases cpp ON cpp.counterparty_id = o.counterparty_id
                LEFT JOIN cp_pending_allocated cpa ON cpa.counterparty_id = o.counterparty_id
                LEFT JOIN cp_pending_debt cpd ON cpd.counterparty_id = c.id
                LEFT JOIN users u_author ON o.user_id = u_author.id
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
    // Единый дашборд отгрузок (строки COI активных заказов)
    // ------------------------------------------------------------------
    router.get('/api/sales/shipment-dashboard', async (req, res) => {
        const plannedFrom = String(req.query.planned_from || '').trim();
        const plannedTo = String(req.query.planned_to || '').trim();
        const search = String(req.query.search || '').trim();
        const onlyDeficitRaw = String(req.query.only_deficit || '').trim().toLowerCase();
        const onlyDeficit = onlyDeficitRaw === 'true' || onlyDeficitRaw === '1' || onlyDeficitRaw === 'yes';
        const hasPlannedDateFilter = Boolean(plannedFrom || plannedTo);
        const SHIPMENT_DASHBOARD_QTY_EPSILON = 0.001;
        const SHIPMENT_DASHBOARD_DEFAULT_LIMIT = 200;
        const SHIPMENT_DASHBOARD_FILTERED_LIMIT = 5000;

        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if (plannedFrom && !dateRe.test(plannedFrom)) {
            return res.status(400).json({ error: 'planned_from: ожидается формат YYYY-MM-DD' });
        }
        if (plannedTo && !dateRe.test(plannedTo)) {
            return res.status(400).json({ error: 'planned_to: ожидается формат YYYY-MM-DD' });
        }

        try {
            const params = [];
            let query = `
                SELECT
                    co.id                          AS order_id,
                    co.doc_number                  AS order_number,
                    co.status                      AS order_status,
                    co.counterparty_id             AS counterparty_id,
                    c.name                         AS client_name,
                    co.planned_shipment_date       AS planned_shipment_date_raw,
                    TO_CHAR(co.planned_shipment_date, 'DD.MM.YYYY') AS planned_shipment_date,
                    coi.id                         AS order_item_id,
                    i.id                           AS item_id,
                    i.name                         AS item_name,
                    i.unit                         AS item_unit,
                    COALESCE(coi.qty_ordered, 0)::numeric   AS qty_ordered,
                    COALESCE(coi.qty_shipped, 0)::numeric  AS qty_shipped,
                    COALESCE(coi.qty_reserved, 0)::numeric AS qty_reserved,
                    COALESCE(coi.qty_production, 0)::numeric AS qty_production,
                    GREATEST(
                        COALESCE(coi.qty_ordered, 0) - COALESCE(coi.qty_shipped, 0),
                        0
                    )::numeric AS qty_remaining,
                    GREATEST(
                        GREATEST(COALESCE(coi.qty_ordered, 0) - COALESCE(coi.qty_shipped, 0), 0)
                        - COALESCE(coi.qty_reserved, 0),
                        0
                    )::numeric AS qty_need_reserve,
                    COALESCE(mv.reserve_movement_bal, 0)::numeric AS reserve_physical_qty,
                    COALESCE(co.pending_debt, 0)::numeric AS order_pending_debt,
                    COALESCE(co.total_amount, 0)::numeric AS order_total_amount,
                    co.created_at                   AS order_created_at
                FROM client_orders co
                INNER JOIN client_order_items coi ON coi.order_id = co.id
                INNER JOIN items i ON i.id = coi.item_id
                    AND COALESCE(i.is_deleted, false) = false
                LEFT JOIN counterparties c ON c.id = co.counterparty_id
                LEFT JOIN LATERAL (
                    SELECT SUM(im.quantity)::numeric AS reserve_movement_bal
                    FROM inventory_movements im
                    INNER JOIN warehouses w ON w.id = im.warehouse_id AND w.type = 'reserve'
                    WHERE im.linked_order_item_id = coi.id
                ) mv ON true
                WHERE co.status IN ('pending', 'processing')
                  AND COALESCE(co.is_deleted, false) = false
                  AND (
                      COALESCE(coi.qty_ordered, 0) - COALESCE(coi.qty_shipped, 0)
                  ) > ${SHIPMENT_DASHBOARD_QTY_EPSILON}
            `;

            if (!hasPlannedDateFilter) {
                query += `
                  AND co.created_at >= (CURRENT_TIMESTAMP - INTERVAL '24 months')
                `;
            }

            if (plannedFrom) {
                params.push(plannedFrom);
                query += ` AND co.planned_shipment_date::date >= $${params.length}::date`;
            }
            if (plannedTo) {
                params.push(plannedTo);
                query += ` AND co.planned_shipment_date::date <= $${params.length}::date`;
            }

            if (search) {
                const searchVal = `%${search}%`;
                params.push(searchVal);
                const pIdx = params.length;
                query += ` AND (
                    co.doc_number ILIKE $${pIdx}
                    OR c.name ILIKE $${pIdx}
                    OR i.name ILIKE $${pIdx}
                )`;
            }

            if (onlyDeficit) {
                query += `
                  AND (
                      COALESCE(coi.qty_production, 0) > ${SHIPMENT_DASHBOARD_QTY_EPSILON}
                      OR GREATEST(
                          GREATEST(COALESCE(coi.qty_ordered, 0) - COALESCE(coi.qty_shipped, 0), 0)
                          - COALESCE(coi.qty_reserved, 0),
                          0
                      ) > ${SHIPMENT_DASHBOARD_QTY_EPSILON}
                  )
                `;
            }

            query += `
                ORDER BY
                    co.planned_shipment_date NULLS LAST,
                    co.doc_number,
                    coi.id
            `;

            const rowLimit = hasPlannedDateFilter
                ? SHIPMENT_DASHBOARD_FILTERED_LIMIT
                : SHIPMENT_DASHBOARD_DEFAULT_LIMIT;
            query += ` LIMIT ${rowLimit}`;

            const result = await pool.query(query, params);
            const rows = result.rows.map((row) => ({
                order_id: Number(row.order_id),
                order_number: row.order_number,
                order_status: row.order_status,
                counterparty_id: row.counterparty_id != null ? Number(row.counterparty_id) : null,
                client_name: row.client_name || null,
                planned_shipment_date: row.planned_shipment_date || null,
                planned_shipment_date_raw: row.planned_shipment_date_raw || null,
                order_item_id: Number(row.order_item_id),
                item_id: Number(row.item_id),
                item_name: row.item_name,
                item_unit: row.item_unit || null,
                qty_ordered: Number(row.qty_ordered || 0),
                qty_shipped: Number(row.qty_shipped || 0),
                qty_reserved: Number(row.qty_reserved || 0),
                qty_production: Number(row.qty_production || 0),
                qty_remaining: Number(row.qty_remaining || 0),
                qty_need_reserve: Number(row.qty_need_reserve || 0),
                reserve_physical_qty: Number(row.reserve_physical_qty || 0),
                order_pending_debt: Number(row.order_pending_debt || 0),
                order_total_amount: Number(row.order_total_amount || 0),
                order_created_at: row.order_created_at
            }));

            const orderIds = new Set();
            let linesWithProductionDeficit = 0;
            let linesWithReserveDeficit = 0;
            for (const row of rows) {
                orderIds.add(row.order_id);
                if (row.qty_production > SHIPMENT_DASHBOARD_QTY_EPSILON) linesWithProductionDeficit += 1;
                if (row.qty_need_reserve > SHIPMENT_DASHBOARD_QTY_EPSILON) linesWithReserveDeficit += 1;
            }

            res.json({
                success: true,
                rows,
                summary: {
                    order_count: orderIds.size,
                    line_count: rows.length,
                    lines_with_production_deficit: linesWithProductionDeficit,
                    lines_with_reserve_deficit: linesWithReserveDeficit,
                    safety_mode: !hasPlannedDateFilter,
                    row_limit: rowLimit,
                    possibly_truncated: rows.length >= rowLimit
                }
            });
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

            const paymentTxRes = await pool.query(
                `
                SELECT id, amount, transaction_type, category, payment_method, account_id, transaction_date
                FROM transactions
                WHERE linked_order_id = $1
                  AND COALESCE(is_deleted, false) = false
                ORDER BY transaction_date ASC, id ASC
                `,
                [orderId]
            );

            res.json({
                order: orderRes.rows[0],
                items: itemsRes.rows,
                payment_transactions: paymentTxRes.rows
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.delete('/api/contracts/:id', requireAdmin, async (req, res) => {
        const contractId = req.params.id;
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления договора' });
        try {
            await withTransaction(pool, async (client) => {
                const specsRes = await client.query('SELECT id, number FROM specifications WHERE contract_id = $1 LIMIT 1', [contractId]);
                if (specsRes.rows.length > 0) throw new Error(`ОШИБКА: Внутри есть спецификация №${specsRes.rows[0].number}. Сначала удалите её!`);
                const ordersRes = await client.query('SELECT id, doc_number FROM client_orders WHERE contract_id = $1 LIMIT 1', [contractId]);
                if (ordersRes.rows.length > 0) throw new Error(`ОШИБКА: К договору привязан заказ (${ordersRes.rows[0].doc_number}).`);
                await client.query('DELETE FROM contracts WHERE id = $1', [contractId]);
            });
            await auditLog(pool, req, 'sales_contract_delete', 'contract', Number(contractId), `reason=${reason}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    router.delete('/api/specifications/:id', requireAdmin, async (req, res) => {
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления спецификации' });
        try {
            await withTransaction(pool, async (client) => {
                await client.query('DELETE FROM specifications WHERE id = $1', [req.params.id]);
            });
            await auditLog(pool, req, 'sales_spec_delete', 'specification', Number(req.params.id), `reason=${reason}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/sales/history', async (req, res) => {
        try {
            const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
            const limitRaw = parseInt(String(req.query.limit || '5'), 10) || 5;
            const limit = Math.min(100, Math.max(1, limitRaw));
            const start = String(req.query.start || '').trim();
            const end = String(req.query.end || '').trim();
            const search = String(req.query.search || '').trim().toLowerCase();
            const clientFilter = String(req.query.client || '').trim().toLowerCase();

            const result = await pool.query(`
                SELECT 
                    COALESCE(m.shipment_doc_number, SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) as doc_num,
                    TO_CHAR(MAX(COALESCE(m.movement_date, m.created_at) + interval '3 hour'), 'DD.MM.YYYY HH24:MI') as date_formatted,
                    MAX(COALESCE(m.movement_date, m.created_at) + interval '3 hour') as raw_date_ts,
                    SUM(ABS(m.quantity)) as total_qty,
                    (SELECT c.name FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id JOIN counterparties c ON co.counterparty_id = c.id WHERE coi.id = MAX(m.linked_order_item_id)) as client_name,
                    (SELECT co.id FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id WHERE coi.id = MAX(m.linked_order_item_id)) as order_id,
                    (SELECT co.counterparty_id FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id WHERE coi.id = MAX(m.linked_order_item_id)) as client_id,
                    (SELECT co.total_amount FROM client_order_items coi JOIN client_orders co ON coi.order_id = co.id WHERE coi.id = MAX(m.linked_order_item_id)) as total_order_amount,
                    SUM(ABS(m.quantity) * COALESCE((SELECT coi.price FROM client_order_items coi WHERE coi.id = m.linked_order_item_id), 0)) as calculated_shipment_amount,
                    true as cancellable
                FROM inventory_movements m
                WHERE m.movement_type = 'sales_shipment'
                GROUP BY COALESCE(m.shipment_doc_number, SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+'))
                HAVING COALESCE(m.shipment_doc_number, SUBSTRING(m.description FROM 'УТ-[0-9]+'), SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) IS NOT NULL
                ORDER BY MAX(m.movement_date) DESC
            `);
            const forcedClosedRes = await pool.query(`
                SELECT
                    co.doc_number as doc_num,
                    TO_CHAR(co.created_at + interval '3 hour', 'DD.MM.YYYY HH24:MI') as date_formatted,
                    co.created_at + interval '3 hour' as raw_date_ts,
                    (SELECT COALESCE(SUM(coi.qty_ordered), 0) FROM client_order_items coi WHERE coi.order_id = co.id)::numeric as total_qty,
                    c.name as client_name,
                    co.id as order_id,
                    co.counterparty_id as client_id,
                    co.total_amount as total_order_amount,
                    co.total_amount::numeric as calculated_shipment_amount,
                    false as cancellable
                FROM client_orders co
                LEFT JOIN counterparties c ON c.id = co.counterparty_id
                WHERE co.status = 'completed'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM client_order_items coi
                    JOIN inventory_movements m ON m.linked_order_item_id = coi.id
                    WHERE coi.order_id = co.id
                      AND m.movement_type = 'sales_shipment'
                  )
                ORDER BY co.created_at DESC
            `);

            const validRows = [
                ...(result.rows || []).filter((r) => r.doc_num),
                ...(forcedClosedRes.rows || []).filter((r) => r.doc_num)
            ];
            if (validRows.length === 0) {
                return res.json({ data: [], pagination: { page: 1, totalPages: 1, total: 0, limit } });
            }

            // Убираем дубли по doc_num (если есть и отгрузка, и строка из forced-close), приоритет у реальной отгрузки.
            const byDoc = new Map();
            for (const row of validRows) {
                const key = String(row.doc_num || '');
                if (!key) continue;
                const prev = byDoc.get(key);
                if (!prev) {
                    byDoc.set(key, row);
                    continue;
                }
                const prevQty = Number(prev.total_qty || 0);
                const curQty = Number(row.total_qty || 0);
                if (curQty > prevQty) byDoc.set(key, row);
            }

            const mergedRows = Array.from(byDoc.values()).filter((row) => {
                const rowDate = row.raw_date_ts ? new Date(row.raw_date_ts).toISOString().slice(0, 10) : '';
                const matchesStart = !start || (rowDate && rowDate >= start);
                const matchesEnd = !end || (rowDate && rowDate <= end);
                const doc = String(row.doc_num || '').toLowerCase();
                const client = String(row.client_name || '').toLowerCase();
                const matchesSearch = !search || doc.includes(search) || client.includes(search);
                const matchesClient = !clientFilter || client === clientFilter;
                return matchesStart && matchesEnd && matchesSearch && matchesClient;
            });

            mergedRows.sort((a, b) => {
                const at = a.raw_date_ts ? new Date(a.raw_date_ts).getTime() : 0;
                const bt = b.raw_date_ts ? new Date(b.raw_date_ts).getTime() : 0;
                return bt - at;
            });

            const total = mergedRows.length;
            const clients = Array.from(new Set(
                mergedRows
                    .map((r) => String(r.client_name || '').trim())
                    .filter(Boolean)
            )).sort((a, b) => a.localeCompare(b, 'ru'));
            const totalPages = Math.max(1, Math.ceil(total / limit));
            const safePage = Math.min(page, totalPages);
            const pageStart = (safePage - 1) * limit;
            const pageRows = mergedRows.slice(pageStart, pageStart + limit);

            if (pageRows.length === 0) {
                return res.json({ data: [], pagination: { page: safePage, totalPages, total, limit } });
            }

            const docNumsPattern = pageRows.map((r) => `%${r.doc_num}%`);
            const docNumsExact = pageRows.map((r) => r.doc_num);

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

            for (const row of pageRows) {
                const tx = txRes.rows.find((t) => t.description && t.description.includes(row.doc_num));
                if (tx) {
                    row.amount = parseFloat(tx.amount) || parseFloat(row.total_order_amount) || 0;
                    row.client_name = row.client_name || tx.client_name;
                    row.payment = '💰 Оплачено';
                } else {
                    const inv = invRes.rows.find((i) => i.invoice_number === row.doc_num);
                    if (inv) {
                        row.amount = parseFloat(inv.amount) || parseFloat(row.total_order_amount) || 0;
                        row.client_name = row.client_name || inv.client_name;
                        row.payment = '⏳ В долг';
                    } else {
                        row.amount = Number(row.cancellable === false)
                            ? null
                            : (parseFloat(row.calculated_shipment_amount) || parseFloat(row.total_order_amount) || 0);
                        row.payment = Number(row.total_qty || 0) > 0 ? '📦 Накладная' : '🧾 Принудительно закрыт';
                    }
                }
            }

            res.json({
                data: pageRows,
                clients,
                pagination: {
                    page: safePage,
                    totalPages,
                    total,
                    limit
                }
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/sales/analytics', async (req, res) => {
        try {
            const topItems = await pool.query(`SELECT i.name, SUM(coi.qty_ordered) as total_qty, SUM(coi.qty_ordered * coi.price) as total_sum FROM client_order_items coi JOIN items i ON coi.item_id = i.id JOIN client_orders co ON coi.order_id = co.id WHERE co.status != 'cancelled' AND COALESCE(co.is_deleted, false) = false GROUP BY i.name ORDER BY total_sum DESC LIMIT 5`);
            const topClients = await pool.query(`SELECT c.name, SUM(co.total_amount) as total_sum FROM client_orders co JOIN counterparties c ON co.counterparty_id = c.id WHERE co.status != 'cancelled' AND COALESCE(co.is_deleted, false) = false GROUP BY c.name ORDER BY total_sum DESC LIMIT 5`);
            const monthRevenue = await pool.query(`SELECT SUM(total_amount) as total FROM client_orders WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE) AND status != 'cancelled' AND COALESCE(is_deleted, false) = false`);
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

    router.post('/api/sales/recipe-pallets-estimate', async (req, res) => {
        try {
            const { items } = req.body || {};
            const result = await estimatePalletsFromRecipes(pool, Array.isArray(items) ? items : []);
            res.json(result);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Не удалось рассчитать поддоны по рецептам' });
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
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления черновика заказа' });
        try {
            await pool.query('DELETE FROM blank_orders WHERE id = $1', [req.params.id]);
            await auditLog(pool, req, 'sales_blank_order_delete', 'blank_order', Number(req.params.id), `reason=${reason}`);
            res.json({ success: true });
        }
        catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // === БАЛАНС КЛИЕНТА (доступный аванс) ===
    router.get('/api/counterparties/:id/balance', async (req, res) => {
        try {
            const cpId = req.params.id;
            const { realBalance: realBalanceBig, totalAdvance, isEmployee } = await getCounterpartyBalance(pool, cpId);
            const realBalance = Number(realBalanceBig.toFixed(2));
            const availableAdvance = Number(totalAdvance.toFixed(2));
            const preferredAccRes = await pool.query(
                `
                SELECT t.account_id, SUM(t.amount) AS total
                FROM transactions t
                WHERE t.counterparty_id = $1
                  AND t.transaction_type = 'income'
                  AND COALESCE(t.is_deleted, false) = false
                  AND t.linked_order_id IS NULL
                  AND t.account_id IS NOT NULL
                  AND COALESCE(t.payment_method, '') <> 'Взаимозачет'
                GROUP BY t.account_id
                ORDER BY SUM(t.amount) DESC, t.account_id ASC
                LIMIT 1
            `,
                [cpId]
            );
            const preferredOffsetAccountId = preferredAccRes.rows.length ? Number(preferredAccRes.rows[0].account_id) : null;

            res.json({ availableAdvance, realBalance, preferredOffsetAccountId, isEmployee });
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