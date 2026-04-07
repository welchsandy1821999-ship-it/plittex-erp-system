const express = require('express');
const router = express.Router();
const Big = require('big.js');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { authenticateToken, requireAdmin } = require('../middleware/auth');

module.exports = function (pool, ERP_CONFIG, withTransaction, COMPANY_CONFIG) {
    async function rotateDocs(directory, maxFiles = 500) {
        try {
            const files = await fsPromises.readdir(directory);
            if (files.length <= maxFiles) return;

            const filesWithStats = await Promise.all(files.map(async (file) => {
                const stats = await fsPromises.stat(path.join(directory, file));
                return { name: file, time: stats.mtime.getTime() };
            }));

            filesWithStats.sort((a, b) => a.time - b.time);
            const toDelete = filesWithStats.slice(0, filesWithStats.length - maxFiles);
            for (const f of toDelete) {
                await fsPromises.unlink(path.join(directory, f.name));
            }
        } catch (e) { console.error('Ошибка ротации файлов:', e.message); }
    }

    // 1. СЧЕТ НА ОПЛАТУ (Invoice - Режим "Нотариус")
    router.all('/print/invoice', authenticateToken, async (req, res) => {
        try {
            let params = { ...req.query, ...req.body };
            if (params.data) {
                try {
                    const parsed = JSON.parse(params.data);
                    params = { ...params, ...parsed };
                } catch (e) { }
            }

            const docNum = params.docNum || params.doc_number || params.orderNum;
            const bank = params.bank || 'tochka';

            const isFreeInvoice = !!params.num; // Свободный счет или счет по договору

            // Защита срабатывает ТОЛЬКО если это не свободный счет и нет номера заказа
            if (!isFreeInvoice && (!docNum || String(docNum).trim() === 'undefined')) {
                return res.status(400).send('<h2>Защита системы</h2><p>Выписка счетов невозможна: укажите Заказ клиента или используйте интерфейс Финансов.</p>');
            }

            let invoiceItems = [];
            let finalAmount = 0;
            let purposeText = '';
            let clientInfo = {};
            let generatedInvoiceNumber = '';

            if (isFreeInvoice) {
                // ЛОГИКА ДЛЯ СВОБОДНЫХ СЧЕТОВ И ДОГОВОРОВ (счет уже записан в базу)
                const cpRes = await pool.query(`
                    SELECT name as client_name, inn as client_inn, kpp as client_kpp, legal_address as client_address 
                    FROM counterparties WHERE id = $1
                `, [params.cp_id]);
                
                const clientObj = cpRes.rows[0] || {};
                clientInfo = { 
                    name: clientObj.client_name || 'Неизвестный клиент', 
                    inn: clientObj.client_inn, 
                    kpp: clientObj.client_kpp, 
                    address: clientObj.client_address 
                };
                
                finalAmount = parseFloat(params.amount || params.custom_amount || 0).toFixed(2);
                purposeText = params.desc || (params.contractId ? 'Оплата по договору' : 'Оплата по счету');
                generatedInvoiceNumber = params.num;
                
                invoiceItems = [{ name: purposeText, qty: 1, unit: 'шт', price: finalAmount }];
            } else {
                // ЛОГИКА ДЛЯ ЗАКАЗОВ КЛИЕНТОВ (Notary-запись в базу)
                await withTransaction(pool, async (client) => {
                    const orderRes = await client.query(`
                        SELECT o.id, o.doc_number, o.counterparty_id, o.total_amount, o.paid_amount, o.discount, o.logistics_cost, o.created_at,
                               c.name as client_name, c.inn as client_inn, c.kpp as client_kpp, c.legal_address as client_address
                        FROM client_orders o 
                        JOIN counterparties c ON o.counterparty_id = c.id 
                        WHERE o.doc_number = $1
                    `, [docNum]);

                    if (orderRes.rows.length === 0) throw new Error('Заказ не найден в базе данных');
                    const order = orderRes.rows[0];

                    clientInfo = { name: order.client_name, inn: order.client_inn, kpp: order.client_kpp, address: order.client_address };
                    const orderDate = order.created_at ? new Date(order.created_at).toLocaleDateString('ru-RU') : new Date().toLocaleDateString('ru-RU');

                    const totalAmount = new Big(order.total_amount || 0);
                    const paidAmount = new Big(order.paid_amount || 0);
                    let debt = totalAmount.minus(paidAmount);
                    
                    if (params.custom_amount) {
                         const requestedAmount = new Big(params.custom_amount);
                         if (requestedAmount.gt(debt)) throw new Error('Запрошенная сумма больше остатка долга!');
                         debt = requestedAmount; 
                         purposeText = `Частичная оплата по заказу № ${docNum} от ${orderDate} г.`;
                    }

                    if (debt.lte(0)) throw new Error(`Заказ №${docNum} уже полностью оплачен. Выписка счета заблокирована.`);

                    finalAmount = debt.toFixed(2);

                    if (!params.custom_amount) {
                         if (paidAmount.gt(0)) {
                             purposeText = `Окончательный расчет (остаток оплаты) по заказу № ${docNum} от ${orderDate} г.`;
                         } else {
                             purposeText = `Оплата по заказу № ${docNum} от ${orderDate} г.`;
                         }
                    }

                    if (paidAmount.gt(0) || params.custom_amount) {
                        invoiceItems = [{ name: purposeText, qty: 1, unit: 'шт', price: finalAmount }];
                    } else {
                        const itemsRes = await client.query(`
                            SELECT it.name, it.unit, coi.qty_ordered as qty, coi.price 
                            FROM client_order_items coi JOIN items it ON coi.item_id = it.id 
                            WHERE coi.order_id = $1
                        `, [order.id]);

                        let items = itemsRes.rows;
                        let itemsSum = new Big(0);
                        items.forEach(item => { itemsSum = itemsSum.plus(new Big(item.qty).times(item.price)); });

                        if (parseFloat(order.discount) > 0) {
                            let dSum = itemsSum.times(order.discount).div(100);
                            items.push({ name: `Скидка на объем ${order.discount}%`, qty: 1, unit: 'шт', price: dSum.times(-1).toFixed(2) });
                        }
                        if (parseFloat(order.logistics_cost) > 0) {
                            items.push({ name: 'Логистика (Доставка)', qty: 1, unit: 'усл', price: parseFloat(order.logistics_cost) });
                        }
                        invoiceItems = items;
                    }

                    let isUnique = false;
                    for (let i = 0; i < 100; i++) {
                        let counterRes = await client.query(`UPDATE document_counters SET last_number = last_number + 1 WHERE prefix = 'СЧ-26-' RETURNING last_number`);
                        if (counterRes.rows.length === 0) {
                            await client.query(`INSERT INTO document_counters (prefix, last_number) VALUES ('СЧ-26-', 0) ON CONFLICT DO NOTHING`);
                            counterRes = await client.query(`UPDATE document_counters SET last_number = last_number + 1 WHERE prefix = 'СЧ-26-' RETURNING last_number`);
                        }
                        let seqNum = counterRes.rows[0].last_number;
                        generatedInvoiceNumber = `СЧ-26-${String(seqNum).padStart(5, '0')}`;
                        
                        const checkRes = await client.query(`SELECT id FROM invoices WHERE invoice_number = $1`, [generatedInvoiceNumber]);
                        if (checkRes.rows.length === 0) {
                            isUnique = true;
                            break;
                        }
                    }
                    if (!isUnique) throw new Error("Системная ошибка: Не удалось найти свободный номер счета.");

                    const authorId = (req.user && req.user.id) ? req.user.id : null;
                    const snapshot = JSON.stringify(clientInfo);
                    const crypto = require('crypto');
                    
                    const createdAt = new Date().toISOString();
                    const hashString = `${generatedInvoiceNumber}|${createdAt}|${finalAmount}|${order.counterparty_id}`;
                    const notaryHash = crypto.createHash('sha256').update(hashString).digest('hex');

                    await client.query(`
                        INSERT INTO invoices (
                            invoice_number, order_id, counterparty_id, total_amount, 
                            purpose, author_id, client_snapshot,
                            created_at, notary_hash, is_locked, locked_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, NOW())
                    `, [generatedInvoiceNumber, order.id, order.counterparty_id, finalAmount, purposeText, authorId, snapshot, createdAt, notaryHash]);
                });
            }

            res.render('docs/invoice', {
                invoiceNum: generatedInvoiceNumber,
                dateLong: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
                clientName: clientInfo.name,
                clientInn: clientInfo.inn || '-',
                clientKpp: clientInfo.kpp || '-',
                clientAddress: clientInfo.address || '',
                bank: bank,
                purposeText: purposeText,
                items: invoiceItems,
                vatRate: ERP_CONFIG.vatRate || 20,
                company: COMPANY_CONFIG
            });
        } catch (err) {
            console.error('Invoice Error:', err);
            res.status(500).send(`<h2>Ошибка генерации счета</h2><p style="color:red; font-weight:bold;">${err.message}</p>`);
        }
    });
    // 2. РАСХОДНАЯ НАКЛАДНАЯ (Waybill)
    router.get('/print/waybill', authenticateToken, async (req, res) => {
        try {
            const { docNum } = req.query;
            const isShipment = docNum && (docNum.startsWith('УТ') || docNum.startsWith('РН') || docNum.startsWith('PH'));
            
            const orderQuery = isShipment 
                ? `SELECT o.id, o.driver_name, o.auto_number, o.discount, o.contract_info, o.total_amount, c.name FROM client_orders o LEFT JOIN counterparties c ON o.counterparty_id = c.id WHERE o.id = (SELECT coi.order_id FROM inventory_movements im JOIN client_order_items coi ON im.linked_order_item_id = coi.id WHERE im.description LIKE '%' || $1 || '%' AND im.movement_type = 'sales_shipment' LIMIT 1)`
                : `SELECT o.id, o.driver_name, o.auto_number, o.discount, o.contract_info, o.total_amount, c.name FROM client_orders o LEFT JOIN counterparties c ON o.counterparty_id = c.id WHERE doc_number = $1`;
                
            const orderRes = await pool.query(orderQuery, [docNum]);

            let data = orderRes.rows[0];
            if (!data) return res.status(404).send('Заказ не найден');

            const itemsQuery = isShipment 
                ? `SELECT i.name, i.unit, SUM(ABS(m.quantity)) as qty FROM inventory_movements m JOIN items i ON m.item_id = i.id WHERE m.movement_type = 'sales_shipment' AND m.linked_order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1) AND m.description LIKE '%' || $2 || '%' GROUP BY i.name, i.unit`
                : `SELECT i.name, i.unit, SUM(ABS(m.quantity)) as qty FROM inventory_movements m JOIN items i ON m.item_id = i.id WHERE m.movement_type = 'sales_shipment' AND m.linked_order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1) GROUP BY i.name, i.unit`;
                
            const itemsRes = await pool.query(itemsQuery, isShipment ? [data.id, docNum] : [data.id]);

            res.render('docs/waybill', {
                docNum,
                clientName: data.name,
                totalAmount: data.total_amount,
                transportInfo: (data.auto_number && data.driver_name) ? `${data.auto_number} (${data.driver_name})` : 'Самовывоз',
                discountInfo: data.discount > 0 ? `${data.discount}%` : '',
                contractInfo: data.contract_info || 'Основной договор',
                items: itemsRes.rows,
                vatRate: ERP_CONFIG.vatRate,
                date: new Date().toLocaleDateString('ru-RU')
            });
        } catch (err) { res.status(500).send(err.message); }
    });

    // 3. УПД (UPD)
    router.get('/print/upd', authenticateToken, async (req, res) => {
        try {
            const { docNum } = req.query;
            const isShipment = docNum && (docNum.startsWith('УТ') || docNum.startsWith('РН') || docNum.startsWith('PH'));

            const orderQuery = isShipment
                ? `SELECT o.id, c.name, c.inn, c.kpp, c.legal_address, o.driver_name, o.auto_number, o.pallets_qty FROM client_orders o JOIN counterparties c ON o.counterparty_id = c.id WHERE o.id = (SELECT coi.order_id FROM inventory_movements im JOIN client_order_items coi ON im.linked_order_item_id = coi.id WHERE im.description LIKE '%' || $1 || '%' AND im.movement_type = 'sales_shipment' LIMIT 1)`
                : `SELECT o.id, c.name, c.inn, c.kpp, c.legal_address, o.driver_name, o.auto_number, o.pallets_qty FROM client_orders o JOIN counterparties c ON o.counterparty_id = c.id WHERE o.doc_number = $1 LIMIT 1`;

            const orderRes = await pool.query(orderQuery, [docNum]);

            if (orderRes.rows.length === 0) return res.status(404).send('Заказ не найден');
            const o = orderRes.rows[0];

            const itemsQuery = isShipment
                ? `SELECT i.name, i.unit, SUM(ABS(m.quantity)) as qty, coi.price FROM inventory_movements m JOIN items i ON m.item_id = i.id LEFT JOIN client_order_items coi ON m.linked_order_item_id = coi.id WHERE m.movement_type = 'sales_shipment' AND coi.order_id = $1 AND m.description LIKE '%' || $2 || '%' GROUP BY i.name, i.unit, coi.price`
                : `SELECT i.name, i.unit, SUM(ABS(m.quantity)) as qty, coi.price FROM inventory_movements m JOIN items i ON m.item_id = i.id LEFT JOIN client_order_items coi ON m.linked_order_item_id = coi.id WHERE m.movement_type = 'sales_shipment' AND coi.order_id = $1 GROUP BY i.name, i.unit, coi.price`;

            const itemsRes = await pool.query(itemsQuery, isShipment ? [o.id, docNum] : [o.id]);

            let totalSum = new Big(0);
            let items = itemsRes.rows.map(row => {
                const lineCost = new Big(row.qty).times(row.price || 0);
                totalSum = totalSum.plus(lineCost);
                return { ...row, cost: lineCost.toFixed(2) };
            });

            if (parseInt(o.pallets_qty) > 0) {
                items.push({ name: 'Поддон деревянный (возвратная тара)', unit: 'шт', qty: o.pallets_qty, price: 0, cost: "0.00" });
            }

            const totalVat = totalSum.times(ERP_CONFIG.vatRate).div(100 + ERP_CONFIG.vatRate).toFixed(2);

            res.render('docs/upd', {
                docNum, cpInfo: o, clientName: o.name, totalAmount: totalSum.toFixed(2), totalVat,
                items, vatRate: ERP_CONFIG.vatRate, company: COMPANY_CONFIG,
                date: new Date().toLocaleDateString('ru-RU'),
                time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            });
        } catch (err) { res.status(500).send(err.message); }
    });

    // 4. ДОГОВОР (Contract)
    router.get('/print/contract', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT c.number, TO_CHAR(c.date, 'DD.MM.YYYY') as date_formatted, cp.* FROM contracts c 
                JOIN counterparties cp ON c.counterparty_id = cp.id 
                WHERE c.id = $1
            `, [req.query.id]);
            if (result.rows.length === 0) return res.status(404).send('Не найден');
            res.render('docs/contract', {
                contract: result.rows[0],
                myCompany: COMPANY_CONFIG,
                vatRate: ERP_CONFIG.vatRate
            });
        } catch (err) { res.status(500).send(err.message); }
    });

    // 5. СПЕЦИФИКАЦИЯ (по номеру заказа)
    router.get('/print/specification', authenticateToken, async (req, res) => {
        try {
            const { docNum } = req.query;
            const isShipment = docNum && (docNum.startsWith('УТ') || docNum.startsWith('РН') || docNum.startsWith('PH'));

            const orderQuery = isShipment
                ? `SELECT o.id, o.total_amount, c.name, con.number as c_num, TO_CHAR(con.date, 'DD.MM.YYYY') as c_date FROM client_orders o JOIN counterparties c ON o.counterparty_id = c.id LEFT JOIN contracts con ON o.contract_id = con.id WHERE o.id = (SELECT coi.order_id FROM inventory_movements im JOIN client_order_items coi ON im.linked_order_item_id = coi.id WHERE im.description LIKE '%' || $1 || '%' AND im.movement_type = 'sales_shipment' LIMIT 1)`
                : `SELECT o.id, o.total_amount, c.name, con.number as c_num, TO_CHAR(con.date, 'DD.MM.YYYY') as c_date FROM client_orders o JOIN counterparties c ON o.counterparty_id = c.id LEFT JOIN contracts con ON o.contract_id = con.id WHERE o.doc_number = $1`;

            const orderRes = await pool.query(orderQuery, [docNum]);

            if (orderRes.rows.length === 0) return res.status(404).send('Заказ не найден');
            const o = orderRes.rows[0];

            const itemsQuery = isShipment
                ? `SELECT i.name, i.unit, coi.price, SUM(ABS(m.quantity)) as qty FROM inventory_movements m JOIN items i ON m.item_id = i.id JOIN client_order_items coi ON m.linked_order_item_id = coi.id WHERE m.movement_type = 'sales_shipment' AND coi.order_id = $1 AND m.description LIKE '%' || $2 || '%' GROUP BY i.name, i.unit, coi.price`
                : `SELECT i.name, i.unit, coi.price, SUM(ABS(m.quantity)) as qty FROM inventory_movements m JOIN items i ON m.item_id = i.id JOIN client_order_items coi ON m.linked_order_item_id = coi.id WHERE m.movement_type = 'sales_shipment' AND coi.order_id = $1 GROUP BY i.name, i.unit, coi.price`;

            const itemsRes = await pool.query(itemsQuery, isShipment ? [o.id, docNum] : [o.id]);

            res.render('docs/specification', {
                docNum, clientName: o.name, totalAmount: o.total_amount,
                contractInfo: o.c_num ? `Договор № ${o.c_num} от ${o.c_date}` : 'Разовая сделка',
                items: itemsRes.rows, vatRate: ERP_CONFIG.vatRate, date: new Date().toLocaleDateString('ru-RU')
            });
        } catch (err) { res.status(500).send(err.message); }
    });

    // 6. СПЕЦИФИКАЦИЯ (по ID документа спецификации)
    router.get('/print/specification_doc', authenticateToken, async (req, res) => {
        try {
            const specRes = await pool.query(`
                SELECT s.number, TO_CHAR(s.date, 'DD.MM.YYYY') as s_date, c.number as c_num, TO_CHAR(c.date, 'DD.MM.YYYY') as c_date, cp.name
                FROM specifications s
                JOIN contracts c ON s.contract_id = c.id
                JOIN counterparties cp ON c.counterparty_id = cp.id
                WHERE s.id = $1
            `, [req.query.id]);

            const s = specRes.rows[0];
            const itemsRes = await pool.query(`
                SELECT i.name, i.unit, si.price, si.qty FROM specification_items si 
                JOIN items i ON si.item_id = i.id WHERE si.specification_id = $1
            `, [req.query.id]);

            let total = new Big(0);
            const items = itemsRes.rows.map(it => {
                total = total.plus(new Big(it.qty).times(it.price));
                return it;
            });

            res.render('docs/specification', {
                docNum: `СПЕЦ-${s.number}`, clientName: s.name, totalAmount: total.toFixed(2),
                contractInfo: `Договор № ${s.c_num} от ${s.c_date}`, items,
                vatRate: ERP_CONFIG.vatRate, date: s.s_date
            });
        } catch (err) { res.status(500).send(err.message); }
    });

    // 7. АКТ СВЕРКИ (Act)
    router.get('/print/act', authenticateToken, async (req, res) => {
        try {
            const { cpId, start, end } = req.query;
            const cpRes = await pool.query('SELECT name, inn FROM counterparties WHERE id = $1', [cpId]);
            const queries = `
                SELECT amount, transaction_type, category, description, 
                       TO_CHAR(transaction_date, 'DD.MM.YYYY') as date, transaction_date as sort_date
                FROM transactions WHERE counterparty_id = $1 AND transaction_date BETWEEN $2 AND $3 AND COALESCE(is_deleted, false) = false
                UNION ALL
                SELECT total_amount as amount, 'expense' as transaction_type, 'Отгрузка продукции' as category, 
                       'Заказ №' || doc_number as description, TO_CHAR(created_at, 'DD.MM.YYYY') as date, created_at as sort_date
                FROM client_orders WHERE counterparty_id = $1 AND created_at BETWEEN $2 AND $3 AND status != 'draft' AND status != 'cancelled'
                UNION ALL
                SELECT amount, 'income' as transaction_type, 'Поставка сырья' as category, 
                       description, TO_CHAR(movement_date, 'DD.MM.YYYY') as date, movement_date as sort_date
                FROM inventory_movements WHERE supplier_id = $1 AND movement_date BETWEEN $2 AND $3 AND movement_type = 'purchase'
            `;
            const transactions = await pool.query(`
                SELECT * FROM (${queries}) AS combined
                ORDER BY sort_date ASC
            `, [cpId, start, end]);

            res.render('docs/act', {
                cp: cpRes.rows[0], transactions: transactions.rows,
                period: { start, end }, company: COMPANY_CONFIG
            });
        } catch (err) { res.status(500).send(err.message); }
    });

    // 8. БЛАНК ЗАКАЗА (Из сохраненного заказа)
    router.get('/print/blank_order', authenticateToken, async (req, res) => {
        try {
            const { docNum } = req.query;
            const orderRes = await pool.query(`
                SELECT o.*, c.name as client_name, c.inn, c.phone, c.legal_address, c.director_name
                FROM client_orders o LEFT JOIN counterparties c ON o.counterparty_id = c.id WHERE o.doc_number = $1
            `, [docNum]);

            if (orderRes.rows.length === 0) return res.status(404).send('Заказ не найден');
            const orderInfo = orderRes.rows[0];

            // 🚀 ИСПРАВЛЕНО: берем qty_ordered и убираем несуществующий coi.discount
            const itemsRes = await pool.query(`
                SELECT i.name, coi.qty_ordered as qty, i.unit, coi.price, 0 as discount
                FROM client_order_items coi JOIN items i ON coi.item_id = i.id WHERE coi.order_id = $1
            `, [orderInfo.id]);

            if (parseInt(orderInfo.pallets_qty) > 0) {
                itemsRes.rows.push({ name: 'Поддон деревянный (возвратная тара)', unit: 'шт', qty: orderInfo.pallets_qty, price: 0, discount: 0 });
            }

            res.render('docs/blank_order', {
                order: orderInfo, items: itemsRes.rows,
                paymentMethod: orderInfo.payment_method, advanceAmount: orderInfo.advance_amount,
                vatRate: ERP_CONFIG.vatRate || 20
            });
        } catch (err) { res.status(500).send(err.message); }
    });

    // 8.1 БЛАНК ЗАКАЗА (Черновик из корзины до сохранения)
    router.post('/print/blank_order_draft', authenticateToken, express.urlencoded({ extended: true }), async (req, res) => {
        try {
            if (!req.body || !req.body.data) return res.status(400).send('Нет данных');
            const data = JSON.parse(req.body.data);

            const clientRes = await pool.query('SELECT name, inn, phone, legal_address, director_name FROM counterparties WHERE id = $1', [data.client_id]);
            const c = clientRes.rows[0] || { name: 'Неизвестный клиент' };

            const items = data.items.map(item => ({ name: item.name, unit: item.unit, qty: parseFloat(item.qty || 0), price: parseFloat(item.price || 0), discount: parseFloat(item.discount || 0) }));

            if (parseInt(data.pallets) > 0) {
                items.push({ name: 'Поддон деревянный (возвратная тара)', unit: 'шт', qty: data.pallets, price: 0, discount: 0 });
            }

            const order = {
                doc_number: 'ПРОЕКТ', created_at: data.orderDate ? new Date(data.orderDate) : new Date(), client_name: c.name, delivery_address: data.delivery_address || c.legal_address, phone: c.phone, inn: c.inn, director_name: c.director_name, discount: data.discount, logistics_cost: data.logistics
            };

            res.render('docs/blank_order', {
                order, items,
                paymentMethod: data.paymentMethod, advanceAmount: data.advanceAmount,
                vatRate: ERP_CONFIG.vatRate || 20
            });
        } catch (err) { res.status(500).send(err.message); }
    });

    // 9. ПАСПОРТ ПАРТИИ (Passport)
    router.get('/print/passport', authenticateToken, async (req, res) => {
        try {
            const { batchId } = req.query;
            const batchRes = await pool.query('SELECT * FROM production_batches WHERE id = $1', [batchId]);
            if (batchRes.rows.length === 0) return res.status(404).send('Партия не найдена');

            res.render('docs/passport', { batch: batchRes.rows[0], company: COMPANY_CONFIG });
        } catch (err) { res.status(500).send(err.message); }
    });

    // 10. API: СОХРАНЕНИЕ PDF
    router.post('/api/docs/save-pdf', requireAdmin, express.json({ limit: '10mb' }), async (req, res) => {
        try {
            const { filename, fileData } = req.body;
            if (!fileData || !filename) return res.status(400).json({ error: 'Данные отсутствуют' });

            const base64Data = fileData.replace(/^data:application\/pdf;base64,/, "")
                .replace(/^data:application\/pdf;filename=generated\.pdf;base64,/, "");

            const dir = path.join(__dirname, '../public/saved_docs');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const finalFilename = `${path.basename(filename, '.pdf')}_${Date.now()}.pdf`;
            await fsPromises.writeFile(path.join(dir, finalFilename), base64Data, 'base64');

            rotateDocs(dir, 500);
            res.json({ success: true, filename: finalFilename });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 11. КАРТОЧКА ПРЕДПРИЯТИЯ (Реквизиты)
    router.get('/print/requisites', authenticateToken, async (req, res) => {
        try {
            const { bank } = req.query;
            if (bank === 'tochka') {
                res.render('docs/card_tochka');
            } else if (bank === 'alfa') {
                res.render('docs/card_alfa');
            } else {
                res.status(404).send('Банк не найден');
            }
        } catch (err) { res.status(500).send(err.message); }
    });

    // 12. КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ (KP)
    router.post('/print/kp', authenticateToken, express.urlencoded({ extended: true }), async (req, res) => {
        try {
            if (!req.body || !req.body.data) return res.status(400).send('Нет данных для КП');
            const data = JSON.parse(req.body.data);

            const clientRes = await pool.query('SELECT name, inn, phone, email FROM counterparties WHERE id = $1', [data.client_id]);
            const clientInfo = clientRes.rows[0] || { name: 'Неизвестный клиент' };

            let totalSum = new Big(0);
            let totalWeight = new Big(0);

            const items = data.items.map(item => {
                const price = new Big(item.price);
                const qty = new Big(item.qty);
                const discount = new Big(item.discount || 0);

                const finalPrice = price.times(new Big(1).minus(discount.div(100)));
                const sum = qty.times(finalPrice);

                totalSum = totalSum.plus(sum);
                totalWeight = totalWeight.plus(item.weight || 0);

                return { ...item, finalPrice: finalPrice.toFixed(2), sum: sum.toFixed(2) };
            });

            const globalDiscount = new Big(data.discount || 0);
            const logistics = new Big(data.logistics || 0);

            const finalTotal = totalSum.times(new Big(1).minus(globalDiscount.div(100))).plus(logistics);

            res.render('docs/kp', {
                client: clientInfo,
                items: items,
                subtotal: totalSum.toFixed(2),
                globalDiscount: data.discount,
                logistics: data.logistics,
                finalTotal: finalTotal.toFixed(2),
                totalWeight: totalWeight.toFixed(1),
                date: data.orderDate ? new Date(data.orderDate).toLocaleDateString('ru-RU') : new Date().toLocaleDateString('ru-RU'),
                company: COMPANY_CONFIG
            });
        } catch (err) {
            console.error('Ошибка генерации КП:', err);
            res.status(500).send('Ошибка генерации КП: ' + err.message);
        }
    });

    // 13. API: РЕЕСТР ДОКУМЕНТОВ ДЛЯ БУХГАЛТЕРИИ
    router.get('/api/docs/registry', async (req, res) => {
        try {
            const { clientId, startDate, endDate } = req.query;
            
            // Базовая часть запроса
            let queryText = `
                SELECT i.id, i.invoice_number as doc_number, i.total_amount, i.created_at, i.is_exported_1c, 
                i.client_snapshot, i.counterparty_id, i.is_locked, i.status, u.username as author_name 
                FROM invoices i
                LEFT JOIN users u ON i.author_id = u.id
            `;
            
            let conditions = [];
            let queryParams = [];
            let paramIndex = 1;

            // Условие 1: Финальный клиент
            if (clientId) {
                conditions.push(`i.counterparty_id = $${paramIndex}`);
                queryParams.push(clientId);
                paramIndex++;
            }

            // Условие 2: Дата начала
            if (startDate) {
                conditions.push(`i.created_at >= $${paramIndex}`);
                queryParams.push(startDate);
                paramIndex++;
            }

            // Условие 3: Дата окончания
            if (endDate) {
                conditions.push(`i.created_at <= $${paramIndex}::timestamp + interval '1 day' - interval '1 second'`);
                queryParams.push(endDate);
                paramIndex++;
            }

            // Сборка конструкции WHERE
            if (conditions.length > 0) {
                queryText += ` WHERE ` + conditions.join(' AND ');
            }

            // Сортировка и лимит
            queryText += ` ORDER BY i.created_at DESC LIMIT 500`;

            const result = await pool.query(queryText, queryParams);
            res.json(result.rows);
        } catch (err) {
            console.error('Registry API error:', err);
            res.status(500).json({ error: err.message });
        }
    });
    // 14. API: ПОЛУЧЕНИЕ ДЕТАЛЕЙ ОДНОГО СЧЕТА ПО ID
    router.get('/api/invoices/:id', async (req, res) => {
        try {
            const invoiceId = req.params.id;

            const result = await pool.query(`
                SELECT i.*, o.doc_number as order_number, u.username as author_name 
                FROM invoices i
                LEFT JOIN client_orders o ON i.order_id = o.id
                LEFT JOIN users u ON i.author_id = u.id
                WHERE i.id = $1
            `, [invoiceId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Счет не найден' });
            }

            res.json(result.rows[0]);
        } catch (err) {
            console.error('Ошибка получения счета:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // 15. API: ВЫГРУЗКА РЕЕСТРА В 1С (XML CommerceML 2.0)
    router.post('/api/docs/export-1c', requireAdmin, async (req, res) => {
        try {
            const { invoiceIds } = req.body;
            if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
                return res.status(400).json({ error: 'Не переданы ID документов для выгрузки' });
            }

            // Получаем счета с актуальной информацией о клиентах
            const result = await pool.query(`
                SELECT i.id, i.invoice_number as doc_number, i.total_amount, i.created_at, i.purpose,
                i.client_snapshot, i.is_exported_1c
                FROM invoices i
                WHERE i.id = ANY($1)
            `, [invoiceIds]);

            const docs = result.rows;
            if (docs.length === 0) return res.status(404).json({ error: 'Документы не найдены в БД' });

            // Формируем XML КоммерческаяИнформация
            const now = new Date();
            const dateStr = now.toISOString().split('T')[0];
            const timeStr = now.toTimeString().split(' ')[0];

            let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
            xml += `<КоммерческаяИнформация ВерсияСхемы="2.09" ДатаФормирования="${dateStr}${timeStr}">\n`;

            for (const doc of docs) {
                const docDate = new Date(doc.created_at).toISOString().split('T')[0];
                const docTime = new Date(doc.created_at).toTimeString().split(' ')[0];
                
                let clientInfo = { name: 'Неизвестно', inn: '', kpp: '' };
                try {
                    if (doc.client_snapshot) {
                        const snap = typeof doc.client_snapshot === 'string' ? JSON.parse(doc.client_snapshot) : doc.client_snapshot;
                        clientInfo = {
                            name: snap.name || snap.clientName || 'Неизвестно',
                            inn: snap.inn || '',
                            kpp: snap.kpp || ''
                        };
                    }
                } catch (e) { console.error('Ошибка парсинга client_snapshot'); }

                xml += `  <Документ>\n`;
                xml += `    <Ид>${doc.id}</Ид>\n`;
                xml += `    <Номер>${doc.doc_number}</Номер>\n`;
                xml += `    <Дата>${docDate}</Дата>\n`;
                xml += `    <Время>${docTime}</Время>\n`;
                xml += `    <ХозОперация>Счет на оплату</ХозОперация>\n`;
                xml += `    <Роль>Продавец</Роль>\n`;
                xml += `    <Сумма>${doc.total_amount}</Сумма>\n`;
                xml += `    <Валюта>руб</Валюта>\n`;
                xml += `    <Курс>1</Курс>\n`;
                
                xml += `    <Контрагенты>\n`;
                xml += `      <Контрагент>\n`;
                xml += `        <Ид>${clientInfo.inn ? clientInfo.inn : 'client_' + doc.id}</Ид>\n`;
                xml += `        <Наименование>${clientInfo.name}</Наименование>\n`;
                xml += `        <Роль>Покупатель</Роль>\n`;
                xml += `        <ПолноеНаименование>${clientInfo.name}</ПолноеНаименование>\n`;
                if (clientInfo.inn) xml += `        <ИНН>${clientInfo.inn}</ИНН>\n`;
                if (clientInfo.kpp) xml += `        <КПП>${clientInfo.kpp}</КПП>\n`;
                xml += `      </Контрагент>\n`;
                xml += `    </Контрагенты>\n`;
                
                xml += `    <Комментарий>${doc.purpose || 'Выгружено из Плиттекс ERP'}</Комментарий>\n`;
                xml += `  </Документ>\n`;
            }

            xml += `</КоммерческаяИнформация>\n`;

            // Помечаем документы как выгруженные (чтобы не выгружать дважды по ошибке)
            await pool.query('UPDATE invoices SET is_exported_1c = true WHERE id = ANY($1)', [invoiceIds]);

            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=export_1c_${dateStr}.xml`);
            res.send(xml);

        } catch (err) {
            console.error('Ошибка генерации XML для 1С:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};