const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = 3000;

const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Настройка хранилища для файлов (чеков и документов)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = './public/uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, 'doc_' + Date.now() + '_' + Math.round(Math.random() * 1000) + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Указываем, что используем шаблонизатор EJS
app.set('view engine', 'ejs');
app.set('views', './views');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL',
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
//ЭТОТ МАРШРУТ (Отдача главной страницы)
app.get('/', (req, res) => {
    res.render('index');
});

// ==========================================
// 1. АВТОРИЗАЦИЯ И СТАРЫЕ МАРШРУТЫ
// ==========================================
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            if (password === user.password_hash) {
                res.json({ message: 'Успех', user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } });
            } else res.status(401).send('Неверный пароль');
        } else res.status(401).send('Пользователь не найден');
    } catch (err) { res.status(500).send('Ошибка сервера'); }
});

// === ПОЛУЧЕНИЕ ТОВАРОВ ДЛЯ ПРОДАЖ (С ГАРАНТИЕЙ ЦЕНЫ) ===
app.get('/api/products', async (req, res) => {
    try {
        // ИСПРАВЛЕНИЕ: колонка называется item_type, а не type
        const result = await pool.query(`SELECT * FROM items WHERE item_type = 'product' ORDER BY name ASC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// === НОВЫЙ МАРШРУТ: МАССОВОЕ СОХРАНЕНИЕ ПРАЙС-ЛИСТА ===
app.post('/api/products/update-prices', async (req, res) => {
    const { prices } = req.body; // Получаем массив { id, price }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ИСПРАВЛЕНИЕ: колонка с ценой в базе называется current_price
        for (let p of prices) {
            await client.query(`UPDATE items SET current_price = $1 WHERE id = $2`, [p.price, p.id]);
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Ошибка сохранения прайса:", err);
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// === ОФОРМЛЕНИЕ ЗАКАЗА OMS (РЕЗЕРВЫ + АВАНСЫ + ПРОИЗВОДСТВО + ЛОГИСТИКА) ===
app.post('/api/sales/checkout', async (req, res) => {
    const {
        counterparty_id, items, payment_method, account_id, advance_amount,
        discount, driver, auto, contract_info, poa_info,
        delivery_address, logistics_cost, planned_shipment_date, pallets_qty, user_id
    } = req.body;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        let subtotalAmount = 0;

        // Префикс теперь всегда ЗК (Заказ Клиента)
        const docNum = `ЗК-${new Date().getTime().toString().slice(-6)}`;

        let desc = 'Заказ (Резерв): ' + docNum;
        if (driver || auto) desc += ` | Транспорт: ${auto || '-'} (Водитель: ${driver || '-'})`;
        if (delivery_address) desc += ` | Доставка: ${delivery_address}`;
        if (discount > 0) desc += ` | Скидка: ${discount}%`;
        if (contract_info) desc += ` | Основание: ${contract_info}`;
        if (poa_info) desc += ` | ${poa_info}`;

        // Фиксируем долг по поддонам
        if (pallets_qty && parseInt(pallets_qty) > 0) {
            await client.query(`UPDATE counterparties SET pallets_balance = pallets_balance + $1 WHERE id = $2`, [parseInt(pallets_qty), counterparty_id]);
            desc += ` | Поддоны (долг): ${pallets_qty} шт.`;
        }

        // Считаем сумму товаров
        for (let item of items) subtotalAmount += (item.qty * item.price);
        let finalAmount = subtotalAmount * (1 - (parseFloat(discount) || 0) / 100);

        // Плюсуем логистику
        if (logistics_cost && parseFloat(logistics_cost) > 0) {
            finalAmount += parseFloat(logistics_cost);
            desc += ` | Логистика: ${logistics_cost} ₽`;
        }

        // 1. СОЗДАЕМ ЗАКАЗ В БАЗЕ
        const orderRes = await client.query(`
            INSERT INTO client_orders (doc_number, counterparty_id, total_amount, delivery_address, logistics_cost, planned_shipment_date, user_id) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
        `, [docNum, counterparty_id, finalAmount, delivery_address || null, logistics_cost || 0, planned_shipment_date || null, user_id || null]);
        const orderId = orderRes.rows[0].id;

        // 2. РАСПРЕДЕЛЯЕМ ТОВАР (Резерв или в План Производства)
        const resWh = await client.query(`SELECT id FROM warehouses WHERE type = 'reserve' LIMIT 1`);
        const reserveWhId = resWh.rows.length > 0 ? resWh.rows[0].id : 7;

        for (let item of items) {
            const whId = item.warehouse_id || 4;
            const stockRes = await client.query(`SELECT batch_id, SUM(quantity) as available FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2 GROUP BY batch_id HAVING SUM(quantity) > 0 ORDER BY MIN(movement_date) ASC`, [item.id, whId]);

            let remainingNeeded = parseFloat(item.qty);
            let qtyReserved = 0;

            for (let row of stockRes.rows) {
                if (remainingNeeded <= 0) break;
                const deduct = Math.min(remainingNeeded, parseFloat(row.available));
                remainingNeeded -= deduct;
                qtyReserved += deduct;

                // Перемещаем реальный остаток в Резерв
                await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id) VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6)`, [item.id, -deduct, desc, whId, row.batch_id, user_id || null]);
                await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id) VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6)`, [item.id, deduct, desc, reserveWhId, row.batch_id, user_id || null]);
            }

            const qtyProduction = remainingNeeded;

            // 🛡️ ЖЕСТКАЯ ЗАЩИТА СЕРВЕРА: Если производство запрещено (выбран ручной склад), а товара не хватило — блокируем заказ!
            if (qtyProduction > 0 && item.allow_production === false) {
                throw new Error(`Попытка обойти систему! На складе №${whId} не хватает товара для позиции ID ${item.id}.`);
            }

            const itemRes = await client.query(`INSERT INTO client_order_items (order_id, item_id, qty_ordered, qty_reserved, qty_production, price) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [orderId, item.id, item.qty, qtyReserved, qtyProduction, item.price]);

            // Кидаем дефицит в цех (только если это разрешено)
            if (qtyProduction > 0 && item.allow_production !== false) {
                await client.query(`INSERT INTO planned_production (order_item_id, item_id, quantity) VALUES ($1, $2, $3)`, [itemRes.rows[0].id, item.id, qtyProduction]);
            }
        }

        // 3. ФИНАНСЫ: АВАНСЫ И ДОЛГИ
        if (payment_method === 'debt') {
            await client.query(`INSERT INTO invoices (counterparty_id, invoice_number, amount, description, status, user_id) VALUES ($1, $2, $3, $4, 'pending', $5)`, [counterparty_id, docNum, finalAmount, desc, user_id || null]);
        } else if (payment_method === 'paid' && account_id) {
            const vatAmount = (finalAmount * 22) / 122;
            await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, user_id) VALUES ($1, 'income', 'Продажа продукции', $2, $3, 'Сразу', $4, $5, $6)`, [finalAmount, desc, vatAmount, account_id, counterparty_id, user_id || null]);
            await client.query(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [finalAmount, account_id]);
        } else if (payment_method === 'partial' && account_id) {
            const adv = parseFloat(advance_amount) || 0;
            const debt = finalAmount - adv;

            if (adv > 0) {
                const vatAmount = (adv * 22) / 122;
                await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, user_id) VALUES ($1, 'income', 'Продажа продукции', $2, $3, 'Аванс', $4, $5, $6)`, [adv, desc + ' (Аванс)', vatAmount, account_id, counterparty_id, user_id || null]);
                await client.query(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [adv, account_id]);
            }
            if (debt > 0) {
                await client.query(`INSERT INTO invoices (counterparty_id, invoice_number, amount, description, status, user_id) VALUES ($1, $2, $3, $4, 'pending', $5)`, [counterparty_id, docNum, debt, desc + ' (Остаток долга)', user_id || null]);
            }
        }

        await client.query('COMMIT');
        // Возвращаем type: 'reserve' принудительно, чтобы скрипт понимал, что это Заказ
        res.json({ success: true, docNum, totalAmount: finalAmount, type: 'reserve' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// === ПРОДАЖИ: ИСТОРИЯ ОТГРУЗОК ===
app.get('/api/sales/history', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COALESCE(SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) as doc_num,
                TO_CHAR(MAX(m.movement_date), 'DD.MM.YYYY HH24:MI') as date_formatted,
                SUM(ABS(m.quantity)) as total_qty
            FROM inventory_movements m
            WHERE m.movement_type = 'sales_shipment' 
            GROUP BY COALESCE(SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+'))
            HAVING COALESCE(SUBSTRING(m.description FROM 'PH-[0-9]+'), SUBSTRING(m.description FROM 'РН-[0-9]+')) IS NOT NULL
            ORDER BY MAX(m.movement_date) DESC
            LIMIT 100
        `);

        if (result.rows.length === 0) return res.json([]);

        for (let row of result.rows) {
            if (!row.doc_num) continue;

            let tx = await pool.query(`SELECT t.amount, c.name as client_name FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id WHERE t.description LIKE $1`, [`%${row.doc_num}%`]);
            if (tx.rows.length > 0) {
                row.amount = tx.rows[0].amount;
                row.client_name = tx.rows[0].client_name;
                row.payment = '💰 Оплачено';
            } else {
                let inv = await pool.query(`SELECT i.amount, c.name as client_name FROM invoices i LEFT JOIN counterparties c ON i.counterparty_id = c.id WHERE i.invoice_number = $1`, [row.doc_num]);
                if (inv.rows.length > 0) {
                    row.amount = inv.rows[0].amount;
                    row.client_name = inv.rows[0].client_name;
                    row.payment = '⏳ В долг';
                }
            }
        }
        res.json(result.rows.filter(r => r.doc_num));
    } catch (err) {
        console.error("❌ ОШИБКА ИСТОРИИ:", err.message);
        res.status(500).send(err.message);
    }
});



// === БЛАНКИ ЗАКАЗОВ (ПРЕДВАРИТЕЛЬНЫЙ РЕЗЕРВ) ===
app.post('/api/blank-orders', async (req, res) => {
    const { counterparty_id, item_id, item_name, warehouse_id, quantity, price } = req.body;
    try {
        const docNum = `БЗ-${new Date().getTime().toString().slice(-6)}`;
        const result = await pool.query(`
            INSERT INTO blank_orders (doc_number, counterparty_id, item_id, item_name, warehouse_id, quantity, price)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, doc_number
        `, [docNum, counterparty_id, item_id, item_name, warehouse_id, quantity, price]);
        res.json({ success: true, docNum: result.rows[0].doc_number, id: result.rows[0].id });
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/blank-orders', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, c.name as client_name, TO_CHAR(b.created_at, 'DD.MM.YYYY HH24:MI') as date_formatted
            FROM blank_orders b
            LEFT JOIN counterparties c ON b.counterparty_id = c.id
            WHERE b.status = 'pending'
            ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/blank-orders/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM blank_orders WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// === ГЕНЕРАЦИЯ ПЕЧАТНОЙ ФОРМЫ: БЛАНК ЗАКАЗА (ЧЕРНОВИК ИЗ КОРЗИНЫ) ===
app.post('/print/kp', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const data = JSON.parse(req.body.data);
        const cpRes = await pool.query('SELECT name, phone, inn, legal_address as address, director_name FROM counterparties WHERE id = $1', [data.client_id]);
        const client = cpRes.rows[0] || { name: 'Неизвестный клиент', phone: '', inn: '', address: '', director_name: '' };

        const orderInfo = {
            doc_number: 'ЧЕРНОВИК',
            date_formatted: new Date().toLocaleDateString('ru-RU'),
            client_name: client.name,
            legal_address: client.address,
            phone: client.phone,
            inn: client.inn,
            director_name: client.director_name
        };

        res.render('docs/blank_order', {
            order: orderInfo,
            items: data.items,
            discount: parseFloat(data.discount) || 0,
            logistics: parseFloat(data.logistics) || 0
        });
    } catch (err) { res.status(500).send('Ошибка генерации Бланка: ' + err.message); }
});

// === СТАРАЯ ФОРМА: ДЛЯ АРХИВНЫХ БЛАНКОВ ЗАКАЗОВ ===
app.get('/print/blank-order', async (req, res) => {
    const { id } = req.query;
    try {
        const bRes = await pool.query(`
            SELECT b.*, c.name as client_name, c.phone, c.inn, c.legal_address, c.director_name, TO_CHAR(b.created_at, 'DD.MM.YYYY') as date_formatted
            FROM blank_orders b
            LEFT JOIN counterparties c ON b.counterparty_id = c.id
            WHERE b.id = $1
        `, [id]);
        if (bRes.rows.length === 0) return res.status(404).send('Документ не найден');

        const orderInfo = bRes.rows[0];
        const singleItem = { name: orderInfo.item_name, qty: orderInfo.quantity, price: orderInfo.price, unit: 'шт' };

        res.render('docs/blank_order', { order: orderInfo, items: [singleItem] });
    } catch (err) { res.status(500).send(err.message); }
});

// === ГЕНЕРАЦИЯ ПЕЧАТНОЙ ФОРМЫ: СЧЕТ НА ОПЛАТУ (УНИВЕРСАЛЬНЫЙ: ЗАКАЗЫ + СВОБОДНЫЕ) ===
app.get('/print/invoice', async (req, res) => {
    const { docNum, cp_id, amount, desc, bank } = req.query;
    try {
        // 1. Общие настройки (Даты, Банки)
        const today = new Date();
        const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
        const dateLong = `${today.getDate()} ${months[today.getMonth()]} ${today.getFullYear()} г.`;

        const deadline = new Date(today);
        deadline.setDate(deadline.getDate() + 5);
        const payUntil = deadline.toLocaleDateString('ru-RU');

        const myCompany = {
            name: 'ООО "ПЛИТТЕКС"',
            inn: '2372029123',
            kpp: '237201001',
            address: '352244, Краснодарский край, г. Новокубанск, ул. Кузнечная, д. 1 оф.2'
        };

        const myBank = bank === 'alfa'
            ? { name: 'АО «Альфа-Банк», г. Москва', account: '40817810405610835875', bik: '044525593', corr: '30101810200000000593' }
            : { name: 'ООО "Банк Точка" г. Москва', account: '40702810901500100003', bik: '044525104', corr: '30101810745374525104' };

        let finalData = {
            payUntil, dateLong, myCompany, myBank,
            invoiceNum: '', docNum: '', amount: 0, baseAmount: 0, vatAmount: 0, amountWords: '', totalOrderSum: 0,
            cp: {}, items: []
        };

        if (docNum) {
            // ---> СЦЕНАРИЙ 1: СЧЕТ ПО КОНКРЕТНОМУ ЗАКАЗУ (ИЗ ПРОДАЖ ИЛИ ФИНАНСОВ)
            const orderRes = await pool.query(`SELECT * FROM client_orders WHERE doc_number = $1`, [docNum]);
            if (orderRes.rows.length === 0) return res.status(404).send('Заказ не найден');
            const order = orderRes.rows[0];

            const cpRes = await pool.query('SELECT id, name, inn, kpp, legal_address FROM counterparties WHERE id = $1', [order.counterparty_id]);
            finalData.cp = cpRes.rows[0] || { name: 'Неизвестный контрагент', inn: '', kpp: '', legal_address: '' };

            const itemsRes = await pool.query(`SELECT i.name, i.unit, coi.qty_ordered as qty, coi.price FROM client_order_items coi JOIN items i ON coi.item_id = i.id WHERE coi.order_id = $1`, [order.id]);
            finalData.items = itemsRes.rows;

            const invRes = await pool.query(`SELECT SUM(amount) as debt FROM invoices WHERE invoice_number = $1 AND status = 'pending'`, [docNum]);
            finalData.totalOrderSum = parseFloat(order.total_amount);
            finalData.amount = invRes.rows[0].debt ? parseFloat(invRes.rows[0].debt) : finalData.totalOrderSum;
            finalData.invoiceNum = docNum; // Сохраняем "ЗК-123456" как номер счета
            finalData.docNum = docNum;

        } else if (cp_id && amount) {
            // ---> СЦЕНАРИЙ 2: СВОБОДНЫЙ СЧЕТ (БЕЗ ЗАКАЗА, ИЗ ФИНАНСОВ)
            const cpRes = await pool.query('SELECT name, inn, kpp, legal_address FROM counterparties WHERE id = $1', [cp_id]);
            if (cpRes.rows.length === 0) return res.status(404).send('Контрагент не найден');
            finalData.cp = cpRes.rows[0];

            finalData.amount = parseFloat(amount);
            finalData.totalOrderSum = finalData.amount; // Авансов нет
            finalData.invoiceNum = `Ф-${new Date().getTime().toString().slice(-4)}`; // Номер с буквой Ф
            finalData.docNum = 'Б/Н (Пополнение баланса)';

            finalData.items = [{ name: desc || 'Оплата за строительные материалы (Аванс)', unit: 'шт', qty: 1, price: finalData.amount }];
        } else {
            return res.status(400).send('Неверные параметры для генерации счета');
        }

        // 3. Финансовые расчеты (для обоих сценариев)
        finalData.vatAmount = (finalData.amount * 22) / 122;
        finalData.baseAmount = finalData.amount - finalData.vatAmount;

        finalData.amountWords = `${finalData.amount.toLocaleString('ru-RU')} руб. 00 коп.`;
        try { if (typeof numberToWordsRu === 'function') finalData.amountWords = numberToWordsRu(finalData.amount); } catch (e) { }

        // === АВТО-СОХРАНЕНИЕ СЧЕТА В БАЗУ ДАННЫХ (ИСПРАВЛЕНО) ===
        try {
            const checkInv = await pool.query(`SELECT id FROM invoices WHERE invoice_number = $1`, [finalData.invoiceNum]);

            // Если такого счета еще нет в базе — записываем его
            if (checkInv.rows.length === 0 && finalData.amount > 0) {
                const descForDb = docNum ? `Оплата по заказу ${docNum}` : (desc || 'Пополнение баланса (Аванс)');
                const targetCpId = finalData.cp.id || cp_id || null;

                if (targetCpId) {
                    // Удален столбец date, так как в БД используется created_at по умолчанию
                    await pool.query(`
                        INSERT INTO invoices (invoice_number, counterparty_id, amount, description, status)
                        VALUES ($1, $2, $3, $4, 'pending')
                    `, [finalData.invoiceNum, targetCpId, finalData.amount, descForDb]);
                }
            }
        } catch (dbErr) {
            console.error(' Ошибка сохранения счета в БД:', dbErr.message);
        }
        // ==========================================================
        res.render('docs/invoice', finalData);
    } catch (err) { res.status(500).send('Ошибка генерации Счета: ' + err.message); }
});

// === ГЕНЕРАЦИЯ ПЕЧАТНОЙ ФОРМЫ: РАСХОДНАЯ НАКЛАДНАЯ (С ДОСТАВКОЙ) ===
app.get('/print/waybill', async (req, res) => {
    const { docNum } = req.query;
    try {
        let clientName = 'Неизвестный клиент';
        let totalAmount = 0;
        let transportInfo = '';
        let discountInfo = '';
        let contractInfo = 'Основной договор'; // По умолчанию

        const txRes = await pool.query(`SELECT t.amount, c.name FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id WHERE t.description LIKE $1`, [`%${docNum}%`]);
        if (txRes.rows.length > 0) {
            totalAmount = txRes.rows[0].amount;
            clientName = txRes.rows[0].name;
        } else {
            const invRes = await pool.query(`SELECT i.amount, c.name FROM invoices i LEFT JOIN counterparties c ON i.counterparty_id = c.id WHERE i.invoice_number = $1`, [docNum]);
            if (invRes.rows.length > 0) {
                totalAmount = invRes.rows[0].amount;
                clientName = invRes.rows[0].name;
            }
        }

        // ИСПРАВЛЕНИЕ: Теперь весь поиск текста находится строго внутри блока if
        const descRes = await pool.query(`SELECT description FROM inventory_movements WHERE movement_type = 'sales_shipment' AND description LIKE $1 LIMIT 1`, [`%${docNum}%`]);
        if (descRes.rows.length > 0) {
            const desc = descRes.rows[0].description;

            const transportMatch = desc.match(/Транспорт:\s([^|]+)/);
            if (transportMatch) transportInfo = transportMatch[1].trim();

            const discMatch = desc.match(/Скидка:\s([^|]+)/);
            if (discMatch) discountInfo = discMatch[1].trim();

            const contractMatch = desc.match(/Основание:\s([^|]+)/);
            if (contractMatch) contractInfo = contractMatch[1].trim();
        }

        const itemsRes = await pool.query(`
            SELECT i.name, i.unit, SUM(ABS(m.quantity)) as qty
            FROM inventory_movements m
            JOIN items i ON m.item_id = i.id
            WHERE m.movement_type = 'sales_shipment' AND m.description LIKE $1
            GROUP BY i.name, i.unit
        `, [`%${docNum}%`]);

        res.render('docs/waybill', {
            docNum, clientName, totalAmount, transportInfo, discountInfo, contractInfo,
            items: itemsRes.rows,
            date: new Date().toLocaleDateString('ru-RU')
        });
    } catch (err) { res.status(500).send(err.message); }
});

// === ГЕНЕРАЦИЯ ПЕЧАТНОЙ ФОРМЫ: ШАБЛОН ДОГОВОРА ===
app.get('/print/contract', async (req, res) => {
    const { id } = req.query;
    try {
        // Достаем договор и все реквизиты контрагента
        const result = await pool.query(`
            SELECT c.number, TO_CHAR(c.date, 'DD.MM.YYYY') as date_formatted, cp.*
            FROM contracts c
            JOIN counterparties cp ON c.counterparty_id = cp.id
            WHERE c.id = $1
        `, [id]);

        if (result.rows.length === 0) return res.status(404).send('Договор не найден');

        const myCompany = {
            name: 'ООО "ПЛИТТЕКС"',
            director: 'Иванов И.И.',
            inn: '2372029123',
            kpp: '237201001',
            address: '352244, Краснодарский край, г. Новокубанск, ул. Кузнечная, д. 1 оф.2',
            bank: 'ООО "Банк Точка" г. Москва',
            account: '40702810901500100003',
            bik: '044525104',
            corr: '30101810745374525104'
        };

        res.render('docs/contract', { contract: result.rows[0], myCompany });
    } catch (err) { res.status(500).send(err.message); }
});

// === ГЕНЕРАЦИЯ ПЕЧАТНОЙ ФОРМЫ: СПЕЦИФИКАЦИЯ ПО ЗАКАЗУ ===
app.get('/print/specification', async (req, res) => {
    const { docNum } = req.query;
    try {
        let clientName = 'Неизвестный клиент';
        let totalAmount = 0;
        let contractInfo = 'Основной договор';

        // Получаем клиента и сумму
        const txRes = await pool.query(`SELECT t.amount, c.name FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id WHERE t.description LIKE $1`, [`%${docNum}%`]);
        if (txRes.rows.length > 0) {
            totalAmount = txRes.rows[0].amount; clientName = txRes.rows[0].name;
        } else {
            const invRes = await pool.query(`SELECT i.amount, c.name FROM invoices i LEFT JOIN counterparties c ON i.counterparty_id = c.id WHERE i.invoice_number = $1`, [docNum]);
            if (invRes.rows.length > 0) { totalAmount = invRes.rows[0].amount; clientName = invRes.rows[0].name; }
        }

        // Вытаскиваем номер договора из описания отгрузки
        const descRes = await pool.query(`SELECT description FROM inventory_movements WHERE movement_type = 'sales_shipment' AND description LIKE $1 LIMIT 1`, [`%${docNum}%`]);
        if (descRes.rows.length > 0) {
            const contractMatch = descRes.rows[0].description.match(/Основание:\s([^|]+)/);
            if (contractMatch) contractInfo = contractMatch[1].trim();
        }

        // Вытаскиваем состав заказа
        const itemsRes = await pool.query(`
            SELECT i.name, i.unit, i.current_price as price, SUM(ABS(m.quantity)) as qty
            FROM inventory_movements m
            JOIN items i ON m.item_id = i.id
            WHERE m.movement_type = 'sales_shipment' AND m.description LIKE $1
            GROUP BY i.name, i.unit, i.current_price
        `, [`%${docNum}%`]);

        res.render('docs/specification', { docNum, clientName, totalAmount, contractInfo, items: itemsRes.rows, date: new Date().toLocaleDateString('ru-RU') });
    } catch (err) { res.status(500).send(err.message); }
});

// === CRM: УПРАВЛЕНИЕ ДОВЕРЕННОСТЯМИ ===
app.get('/api/counterparties/:id/poas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, driver_name, number, 
                   TO_CHAR(issue_date, 'DD.MM.YYYY') as issue_date, 
                   TO_CHAR(expiry_date, 'DD.MM.YYYY') as expiry_date
            FROM powers_of_attorney
            WHERE counterparty_id = $1 AND expiry_date >= CURRENT_DATE
            ORDER BY expiry_date ASC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/poas', async (req, res) => {
    const { counterparty_id, driver_name, number, issue_date, expiry_date } = req.body;
    try {
        await pool.query(`
            INSERT INTO powers_of_attorney (counterparty_id, driver_name, number, issue_date, expiry_date) 
            VALUES ($1, $2, $3, $4, $5)
        `, [counterparty_id, driver_name, number, issue_date, expiry_date]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// === ФИНАНСЫ: АНАЛИТИКА С ДИАПАЗОНОМ ДАТ ===
app.get('/api/report/finance', async (req, res) => {
    const { start, end } = req.query;
    let where = '';
    let params = [];

    // Если переданы даты, фильтруем от начала до конца дня
    if (start && end) {
        where = `WHERE created_at::date >= $1 AND created_at::date <= $2`;
        params = [start, end];
    }

    try {
        const result = await pool.query(`
            SELECT category, 
                   SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) as income,
                   SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) as expense
            FROM transactions ${where} GROUP BY category;
        `, params);
        res.json(result.rows);
    } catch (err) { res.status(500).send('Ошибка аналитики'); }
});

// 1. Получить список всех счетов для дашборда и выпадающих списков
app.get('/api/accounts', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM accounts ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// 2. Создать новый счет (например, "Тинькофф" или "Сейф")
app.post('/api/accounts', async (req, res) => {
    const { name, type, balance } = req.body;
    try {
        await pool.query('INSERT INTO accounts (name, type, balance) VALUES ($1, $2, $3)',
            [name, type, balance || 0]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// 3. Обновленное ручное добавление операции (с учетом счета и контрагента)
app.post('/api/transactions', async (req, res) => {
    const { amount, type, category, description, method, account_id, counterparty_id } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id)
            VALUES ($1, $2, $3, $4, 0, $5, $6, $7)
        `, [amount, type, category, description, method, account_id, counterparty_id || null]);

        const balanceChange = type === 'income' ? amount : -amount;
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, account_id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// 4. Внутренний перевод (например, из Кассы в Банк)
app.post('/api/transactions/transfer', async (req, res) => {
    const { from_id, to_id, amount, description } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const comment = `Внутренний перевод: ${description}`;

        // Списание
        await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, from_id]);
        await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id) 
                            VALUES ($1, 'expense', 'Перевод', $2, $3)`, [amount, comment, from_id]);

        // Зачисление
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, to_id]);
        await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id) 
                            VALUES ($1, 'income', 'Перевод', $2, $3)`, [amount, comment, to_id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// БЛОК 1: Маршрут для безопасного удаления транзакции и отката баланса
app.delete('/api/transactions/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const transId = req.params.id;

        // 1. Сначала ищем данные транзакции
        const transRes = await client.query('SELECT amount, transaction_type, account_id FROM transactions WHERE id = $1', [transId]);
        if (transRes.rows.length === 0) throw new Error('Транзакция не найдена');
        const trans = transRes.rows[0];

        // 2. ВАЖНО: Если эта транзакция была выплатой зарплаты, удаляем её из таблицы зарплат
        // Мы ищем запись в salary_payments, у которой linked_transaction_id совпадает с нашей транзакцией
        await client.query('DELETE FROM salary_payments WHERE linked_transaction_id = $1', [transId]);

        // 3. Откатываем баланс счета
        if (trans.account_id) {
            const balanceChange = trans.transaction_type === 'income' ? -trans.amount : trans.amount;
            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, trans.account_id]);
        }

        // 4. Удаляем саму транзакцию
        await client.query('DELETE FROM transactions WHERE id = $1', [transId]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// === ФИНАНСЫ: ИМПОРТ БАНКОВСКОЙ ВЫПИСКИ (1С ФОРМАТ) ===
app.post('/api/transactions/import', async (req, res) => {
    const { account_id, transactions } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        let importedCount = 0;

        for (let tr of transactions) {
            let cp_id = null;

            // 🛡️ ПРЕДОХРАНИТЕЛЬ 2.0: Вытаскиваем чистый ИНН (отсекаем КПП) и жестко режем до 20 символов
            let safeInn = null;
            if (tr.counterparty_inn) {
                // Если банк прислал "ИНН/КПП" или "ИНН\КПП", берем только первую часть до слеша:
                safeInn = String(tr.counterparty_inn).split('/')[0].split('\\')[0].trim().substring(0, 20);
            }
            const safeName = tr.counterparty_name ? String(tr.counterparty_name).substring(0, 140) : 'Неизвестный партнер';
            const cpType = tr.type === 'income' ? 'Покупатель' : 'Поставщик';

            // 1. Ищем или создаем контрагента
            if (safeInn) {
                // Если ИНН есть
                let cpRes = await client.query('SELECT id FROM counterparties WHERE inn = $1 LIMIT 1', [safeInn]);
                if (cpRes.rows.length > 0) {
                    cp_id = cpRes.rows[0].id;
                } else {
                    const newCp = await client.query(`
                        INSERT INTO counterparties (name, inn, type) VALUES ($1, $2, $3) RETURNING id
                    `, [safeName, safeInn, cpType]);
                    cp_id = newCp.rows[0].id;
                }
            } else {
                // Если ИНН нет (например, комиссия банка) - ищем по имени
                let cpRes = await client.query('SELECT id FROM counterparties WHERE name = $1 LIMIT 1', [safeName]);
                if (cpRes.rows.length > 0) {
                    cp_id = cpRes.rows[0].id;
                } else {
                    const newCp = await client.query(`
                        INSERT INTO counterparties (name, type) VALUES ($1, $2) RETURNING id
                    `, [safeName, cpType]);
                    cp_id = newCp.rows[0].id;
                }
            }

            // Умная защита от дубликатов (сверяем дату, сумму и описание)
            const dupCheck = await client.query(`
                SELECT id FROM transactions 
                WHERE account_id = $1 AND amount = $2 AND description = $3 AND transaction_type = $4 AND created_at::date = $5::date
                LIMIT 1
            `, [account_id, tr.amount, tr.description, tr.type, tr.date || new Date()]);

            // Если дубликата нет, начинаем обработку нового платежа
            if (dupCheck.rows.length === 0) {

                // === 1. БЛОК УМНОГО АВТО-РАСПРЕДЕЛЕНИЯ КАТЕГОРИЙ ===
                // Ставим категории по умолчанию на случай, если программа не найдет совпадений
                let category = tr.type === 'income' ? 'Продажа продукции' : 'Закупка сырья';

                // Переводим текст назначения и имя контрагента в нижний регистр для удобного поиска
                const desc = (tr.description || '').toLowerCase();
                const cpName = (tr.counterparty_name || '').toLowerCase();

                // Правила для исходящих платежей (Расходы)
                if (tr.type === 'expense') {
                    if (cpName.includes('уфк') || cpName.includes('казначейство') || desc.includes('налог') || desc.includes('взыскан') || desc.includes('росп')) {
                        category = 'Налоги, штрафы и взносы';
                    } else if (desc.includes('лицензион') || desc.includes('комисс') || cpName.includes('банк')) {
                        category = 'Услуги банка и РКО';
                    } else if (desc.includes('аренд')) {
                        category = 'Аренда помещений';
                    } else if (desc.includes('займ') || desc.includes('заем')) {
                        category = 'Возврат займов';
                    } else if (desc.includes('зарплат') || desc.includes('оплат труда') || desc.includes('аванс')) {
                        category = 'Зарплата';
                    } else if (desc.includes('материал') || desc.includes('сырь') || desc.includes('цемент')) {
                        category = 'Закупка сырья';
                    }
                }
                // Правила для входящих платежей (Доходы)
                else if (tr.type === 'income') {
                    if (desc.includes('займ') || desc.includes('заем')) {
                        category = 'Получение займов';
                    } else if (desc.includes('возврат')) {
                        category = 'Возврат средств';
                    }
                }
                // ====================================================

                // Сохраняем операцию в базу данных с уже определенной категорией
                await client.query(`
                    INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, created_at)
                    VALUES ($1, $2, $3, $4, 'Безналичный расчет (Импорт)', $5, $6, COALESCE($7, CURRENT_TIMESTAMP))
                `, [tr.amount, tr.type, category, tr.description, account_id, cp_id, tr.date]);

                // Корректируем баланс банковского счета
                const balanceChange = tr.type === 'income' ? tr.amount : -tr.amount;
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, account_id]);

                // Увеличиваем счетчик успешно загруженных операций
                importedCount++;
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, count: importedCount });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ошибка импорта:', err);
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// === ОБНОВЛЕНИЕ ТРАНЗАКЦИИ (РЕДАКТИРОВАНИЕ) ===
app.put('/api/transactions/:id', async (req, res) => {
    const transId = req.params.id;
    const { description, amount, category, account_id, counterparty_id } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Начинаем транзакцию для безопасности

        // 1. Получаем старые данные платежа, чтобы понять, как откатить баланс
        const oldTrans = await client.query('SELECT amount, transaction_type, account_id FROM transactions WHERE id = $1', [transId]);
        if (oldTrans.rows.length === 0) throw new Error('Транзакция не найдена');
        const old = oldTrans.rows[0];

        // 2. Откатываем влияние старой суммы на баланс старого счета
        if (old.account_id) {
            const revertAmount = old.transaction_type === 'income' ? -old.amount : old.amount;
            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [revertAmount, old.account_id]);
        }

        // 3. Сохраняем новые данные (комментарий, новую сумму, новую категорию и т.д.)
        await client.query(`
            UPDATE transactions 
            SET description = $1, amount = $2, category = $3, account_id = $4, counterparty_id = $5
            WHERE id = $6
        `, [description, amount, category, account_id, counterparty_id || null, transId]);

        // 4. Применяем влияние новой суммы на баланс выбранного счета
        if (account_id) {
            const applyAmount = old.transaction_type === 'income' ? amount : -amount;
            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [applyAmount, account_id]);
        }

        await client.query('COMMIT'); // Подтверждаем изменения
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK'); // Если ошибка - отменяем все изменения балансов
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// === ФИНАНСЫ: ПРИКРЕПЛЕНИЕ ФАЙЛОВ И ЧЕКОВ ===
app.post('/api/transactions/:id/receipt', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('Файл не загружен');
        const fileUrl = '/uploads/' + req.file.filename;
        await pool.query('UPDATE transactions SET receipt_url = $1 WHERE id = $2', [fileUrl, req.params.id]);
        res.json({ success: true, url: fileUrl });
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/transactions/:id/receipt', async (req, res) => {
    try {
        await pool.query('UPDATE transactions SET receipt_url = NULL WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// === ФИНАНСЫ: ОТЧЕТ P&L (ПРИБЫЛИ И УБЫТКИ) ===
app.get('/api/finance/pnl', async (req, res) => {
    const { start, end } = req.query;
    let params = []; let where = 'WHERE 1=1';
    if (start && end) {
        where += ` AND created_at::date >= $1 AND created_at::date <= $2`;
        params = [start, end];
    }
    try {
        const transRes = await pool.query(`SELECT category, transaction_type, SUM(amount) as total FROM transactions ${where} GROUP BY category, transaction_type`, params);

        let revenue = 0; let directCosts = 0; let indirectCosts = 0;
        // Эти категории считаем прямой себестоимостью, остальное - косвенные расходы
        const directCategories = ['Закупка сырья', 'Зарплата'];

        transRes.rows.forEach(r => {
            const amt = parseFloat(r.total);
            if (r.transaction_type === 'income') revenue += amt;
            else {
                if (directCategories.includes(r.category)) directCosts += amt;
                else indirectCosts += amt;
            }
        });

        const grossProfit = revenue - directCosts; // Маржинальная прибыль
        const netProfit = grossProfit - indirectCosts; // Чистая прибыль
        const margin = revenue > 0 ? ((netProfit / revenue) * 100).toFixed(1) : 0;

        res.json({ revenue, directCosts, indirectCosts, grossProfit, netProfit, margin });
    } catch (err) { res.status(500).send(err.message); }
});

// === ФИНАНСЫ: ПЛАТЕЖНЫЙ КАЛЕНДАРЬ (ПЛАНОВЫЕ РАСХОДЫ) ===

// 1. Получить список (изменили адрес с /calendar на /planned-expenses для совместимости)
app.get('/api/finance/planned-expenses', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, TO_CHAR(date, 'DD.MM.YYYY') as date, category, description, amount, is_recurring 
            FROM planned_expenses 
            WHERE status = 'pending'
            ORDER BY date ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Ошибка загрузки календаря:', err.message);
        res.json([]);
    }
});

// 2. Проведение оплаты (Списание реальных денег)
app.post('/api/finance/planned-expenses/:id/pay', async (req, res) => {
    const { account_id } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Помечаем план как оплаченный
        const expRes = await client.query("UPDATE planned_expenses SET status = 'paid' WHERE id = $1 RETURNING *", [req.params.id]);
        if (expRes.rows.length === 0) throw new Error('Платеж не найден');
        const exp = expRes.rows[0];

        // Создаем реальную транзакцию расхода
        const desc = `Оплата плана: ${exp.category} (${exp.description || ''})`;
        await client.query(`
            INSERT INTO transactions (account_id, amount, transaction_type, category, description, date)
            VALUES ($1, $2, 'expense', $3, $4, CURRENT_DATE)
        `, [account_id, exp.amount, exp.category, desc]);

        // Списываем баланс со счета
        await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [exp.amount, account_id]);

        // Если платеж регулярный — создаем такой же на следующий месяц
        if (exp.is_recurring) {
            const nextDate = new Date(exp.date);
            nextDate.setMonth(nextDate.getMonth() + 1);
            await client.query(
                'INSERT INTO planned_expenses (date, amount, category, description, is_recurring, status) VALUES ($1, $2, $3, $4, $5, $6)',
                [nextDate, exp.amount, exp.category, exp.description, true, 'pending']
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).send(e.message);
    } finally { client.release(); }
});

// ===============================================
/// 5. История транзакций с пагинацией и УМНЫМ ПОИСКОМ
app.get('/api/transactions', async (req, res) => {
    const { start, end, page = 1, limit = 20, account_id, search } = req.query;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    let params = [];
    let pIdx = 1;

    if (start && end) {
        where += ` AND t.created_at::date >= $${pIdx} AND t.created_at::date <= $${pIdx + 1}`;
        params.push(start, end);
        pIdx += 2;
    }
    if (account_id) {
        where += ` AND t.account_id = $${pIdx}`;
        params.push(account_id);
        pIdx++;
    }
    // ДОБАВЛЕНА ЛОГИКА ПОИСКА ПО ИНН, ИМЕНИ ИЛИ ОПИСАНИЮ
    if (search) {
        where += ` AND (c.name ILIKE $${pIdx} OR c.inn ILIKE $${pIdx} OR t.description ILIKE $${pIdx})`;
        params.push(`%${search}%`);
        pIdx++;
    }

    try {
        // ВАЖНО: Добавили LEFT JOIN, чтобы счетчик страниц умел искать по ИНН контрагента
        const countRes = await pool.query(`
            SELECT COUNT(*) FROM transactions t 
            LEFT JOIN counterparties c ON t.counterparty_id = c.id
            ${where}
        `, params);
        const total = parseInt(countRes.rows[0].count);

        const result = await pool.query(`
            SELECT t.id, t.amount, t.transaction_type, t.category, t.description, t.payment_method, t.account_id, t.counterparty_id, t.receipt_url,
                   COALESCE(a.name, 'Не указан') as account_name,
                   c.name as counterparty_name,
                   TO_CHAR(COALESCE(t.created_at, NOW()), 'DD.MM.YYYY HH24:MI') as date_formatted
            FROM transactions t
            LEFT JOIN accounts a ON t.account_id = a.id
            LEFT JOIN counterparties c ON t.counterparty_id = c.id
            ${where}
            ORDER BY t.created_at DESC, t.id DESC 
            LIMIT $${pIdx} OFFSET $${pIdx + 1}
        `, [...params, limit, offset]);

        res.json({
            data: result.rows,
            total: total,
            totalPages: Math.ceil(total / limit) || 1,
            currentPage: parseInt(page)
        });
    } catch (err) { res.status(500).send(err.message); }
});

// НОВЫЙ МАРШРУТ: Массовое удаление операций с пересчетом баланса
app.post('/api/transactions/bulk-delete', async (req, res) => {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.json({ success: true });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Получаем данные удаляемых транзакций, чтобы откатить балансы
        const transRes = await client.query(`SELECT amount, transaction_type, account_id FROM transactions WHERE id = ANY($1::int[])`, [ids]);

        for (let trans of transRes.rows) {
            if (trans.account_id) {
                const balanceChange = trans.transaction_type === 'income' ? -trans.amount : trans.amount;
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, trans.account_id]);
            }
        }

        await client.query(`DELETE FROM transactions WHERE id = ANY($1::int[])`, [ids]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// === ФИНАНСЫ: УПРАВЛЕНИЕ КАТЕГОРИЯМИ ===
app.get('/api/finance/categories', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transaction_categories ORDER BY type, name');
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/finance/categories', async (req, res) => {
    try {
        await pool.query('INSERT INTO transaction_categories (name, type) VALUES ($1, $2)', [req.body.name, req.body.type]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/finance/categories/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM transaction_categories WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// === ФИНАНСЫ: ПОЛНОЦЕННЫЕ КОНТРАГЕНТЫ (CRM) ===
app.get('/api/counterparties', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, 
                   COALESCE(SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END), 0) as total_paid_to_us,
                   COALESCE(SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END), 0) as total_paid_by_us,
                   MAX(t.created_at) as last_transaction_date
            FROM counterparties c
            LEFT JOIN transactions t ON c.id = t.counterparty_id
            GROUP BY c.id
            ORDER BY last_transaction_date DESC NULLS LAST, c.name ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/counterparties', async (req, res) => {
    const { name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name } = req.body;
    try {
        await pool.query(`
            INSERT INTO counterparties (name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name]);
        res.json({ success: true });
    } catch (err) {
        // ВЫВОДИМ ОШИБКУ ПРЯМО В ТЕРМИНАЛ
        console.error('❌ ОШИБКА ПРИ ДОБАВЛЕНИИ КОНТРАГЕНТА:', err.message);
        res.status(500).send(err.message);
    }
});

app.put('/api/counterparties/:id', async (req, res) => {
    const { name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name } = req.body;
    try {
        await pool.query(`
            UPDATE counterparties 
            SET name=$1, type=$2, inn=$3, kpp=$4, ogrn=$5, legal_address=$6, phone=$7, email=$8, bank_name=$9, bik=$10, checking_account=$11, director_name=$12
            WHERE id=$13
        `, [name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/counterparties/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE transactions SET counterparty_id = NULL WHERE counterparty_id = $1', [req.params.id]);
        await client.query('DELETE FROM counterparties WHERE id = $1', [req.params.id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// === ПОЛНЫЙ ПРОФИЛЬ КОНТРАГЕНТА ДЛЯ CRM ===
app.get('/api/counterparties/:id/profile', async (req, res) => {
    const cpId = req.params.id;
    try {
        // 1. Данные контрагента
        const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
        if (cpRes.rows.length === 0) return res.status(404).send('Не найден');
        const cp = cpRes.rows[0];

        // 2. История всех платежей
        const transRes = await pool.query(`
            SELECT id, amount, transaction_type, category, description, TO_CHAR(created_at, 'DD.MM.YYYY') as date
            FROM transactions WHERE counterparty_id = $1 ORDER BY created_at DESC
        `, [cpId]);

        // 3. Выставленные счета (Ожидаемые)
        const invRes = await pool.query(`
            SELECT id, invoice_number, amount, description, status, TO_CHAR(created_at, 'DD.MM.YYYY') as date
            FROM invoices WHERE counterparty_id = $1 ORDER BY id DESC
        `, [cpId]);

        // 4. ДОГОВОРЫ КОНТРАГЕНТА (Новое!)
        const contractsRes = await pool.query(`
            SELECT id, number, TO_CHAR(date, 'DD.MM.YYYY') as date 
            FROM contracts WHERE counterparty_id = $1 ORDER BY date DESC
        `, [cpId]);

        res.json({
            info: cp,
            transactions: transRes.rows,
            invoices: invRes.rows,
            contracts: contractsRes.rows
        });
    } catch (err) { res.status(500).send(err.message); }
});

// 3. Генерация печатной формы: АКТ СВЕРКИ (Через EJS)
app.get('/print/act', async (req, res) => {
    const { cp_id } = req.query;
    try {
        const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cp_id]);
        if (cpRes.rows.length === 0) return res.status(404).send('Контрагент не найден');
        const cp = cpRes.rows[0];

        const transRes = await pool.query(`
            SELECT amount, transaction_type, category, description, TO_CHAR(created_at, 'DD.MM.YYYY') as date
            FROM transactions WHERE counterparty_id = $1 ORDER BY created_at ASC
        `, [cp_id]);

        // Рендерим новый красивый EJS шаблон
        res.render('docs/act', {
            cp: cp,
            transactions: transRes.rows
        });
    } catch (err) { res.status(500).send(err.message); }
});

// === CRM: УПРАВЛЕНИЕ ДОГОВОРАМИ И СПЕЦИФИКАЦИЯМИ ===

// Получить все договоры клиента (вместе с их спецификациями)
app.get('/api/counterparties/:id/contracts', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.id as contract_id, c.number as contract_number, TO_CHAR(c.date, 'DD.MM.YYYY') as contract_date,
                   s.id as spec_id, s.number as spec_number, TO_CHAR(s.date, 'DD.MM.YYYY') as spec_date
            FROM contracts c
            LEFT JOIN specifications s ON c.id = s.contract_id
            WHERE c.counterparty_id = $1
            ORDER BY c.date DESC, s.date DESC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Создать новый договор
app.post('/api/contracts', async (req, res) => {
    const { counterparty_id, number, date } = req.body;
    try {
        const result = await pool.query(`INSERT INTO contracts (counterparty_id, number, date) VALUES ($1, $2, $3) RETURNING id`, [counterparty_id, number, date]);
        res.json({ success: true, contract_id: result.rows[0].id });
    } catch (err) { res.status(500).send(err.message); }
});

// === НОВЫЙ МАРШРУТ: УДАЛЕНИЕ ДОГОВОРА ===
app.delete('/api/contracts/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM contracts WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// Создать новую спецификацию к договору
app.post('/api/specifications', async (req, res) => {
    const { contract_id, number, date } = req.body;
    try {
        await pool.query(`INSERT INTO specifications (contract_id, number, date) VALUES ($1, $2, $3)`, [contract_id, number, date]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// === web.js: Управление замесами ===

// 1. Получение дефолтных норм замесов (из БД)
app.get('/api/mix-templates', async (req, res) => {
    try {
        const result = await pool.query(`SELECT value FROM settings WHERE key = 'mix_templates'`);
        if (result.rows.length > 0) res.json(result.rows[0].value);
        else res.json({ big: [], small: [] });
    } catch (err) { res.status(500).send(err.message); }
});

// Сохранение обновленных норм замесов
app.post('/api/mix-templates', async (req, res) => {
    try {
        await pool.query(`
            INSERT INTO settings (key, value) VALUES ('mix_templates', $1)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// === ОБНОВЛЕННЫЙ МАРШРУТ: ФИКСАЦИЯ ПРОИЗВОДСТВА ===
app.post('/api/production', async (req, res) => {
    let { date, shiftName, products, materialsUsed } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 🛡️ ЖЕСТКАЯ ЗАЩИТА: Очищаем массив от "призраков" (материалов без ID)
        if (materialsUsed) {
            materialsUsed = materialsUsed.filter(m => m.id && String(m.id).trim() !== '');
        }

        // 1. Подтягиваем актуальные цены на сырье
        let itemPrices = [];
        if (materialsUsed && materialsUsed.length > 0) {
            const matIds = materialsUsed.map(m => m.id);
            const itemsRes = await client.query(`SELECT id, current_price FROM items WHERE id = ANY($1::int[])`, [matIds]);
            itemPrices = itemsRes.rows;
        }

        // 1.5. 🚀 УМНЫЙ РАСЧЕТ АМОРТИЗАЦИИ (ИЗ МАТРИЦЫ И СТАНКА)
        const productIds = products.map(p => p.id);

        // Получаем амортизацию матрицы для каждого товара (Стоимость / Плановые удары)
        const prodInfoRes = await client.query(`
            SELECT i.id, 
                   i.amortization_per_cycle as manual_amort,
                   (e.purchase_cost / NULLIF(e.planned_cycles, 0)) as mold_amort
            FROM items i
            LEFT JOIN equipment e ON i.mold_id = e.id
            WHERE i.id = ANY($1::int[])
        `, [productIds]);

        // Получаем амортизацию главного станка (Вибропресса)
        const machineRes = await client.query(`
            SELECT (purchase_cost / NULLIF(planned_cycles, 0)) as machine_amort 
            FROM equipment 
            WHERE equipment_type = 'machine' AND status = 'active' 
            LIMIT 1
        `);
        const machineAmort = machineRes.rows.length > 0 ? parseFloat(machineRes.rows[0].machine_amort) || 0 : 0;

        const prodInfos = prodInfoRes.rows;

        // 2. Считаем общий объем продукции в смене (для пропорций)
        const totalProductsVolume = products.reduce((sum, p) => sum + parseFloat(p.quantity), 0);

        // 3. Создаем партии в сушилке С УЧЕТОМ АМОРТИЗАЦИИ (БЕЗ ДУБЛИРОВАНИЯ)
        const createdBatches = [];
        for (let p of products) {
            const batchNumber = `П-${date.replace(/-/g, '')}-${Math.floor(Math.random() * 1000)}`;
            const volumeFraction = totalProductsVolume > 0 ? (parseFloat(p.quantity) / totalProductsVolume) : 0;

            // 🧮 МАГИЯ СЕБЕСТОИМОСТИ: Считаем износ оборудования
            const pInfo = prodInfos.find(info => info.id == p.id);
            const manualAmort = pInfo ? (parseFloat(pInfo.manual_amort) || 0) : 0;
            const moldAmort = pInfo ? (parseFloat(pInfo.mold_amort) || 0) : 0;

            // Считаем отдельно матрицу и отдельно станок
            const actualMoldAmortPerCycle = manualAmort > 0 ? manualAmort : moldAmort;
            const totalMoldAmortCost = (parseFloat(p.cycles) || 0) * actualMoldAmortPerCycle;
            const totalMachineAmortCost = (parseFloat(p.cycles) || 0) * machineAmort;
            const totalAmortCost = totalMoldAmortCost + totalMachineAmortCost;

            // Сохраняем партию, записывая амортизацию раздельно в новые колонки
            const batchRes = await client.query(`
                INSERT INTO production_batches 
                (batch_number, product_id, planned_quantity, status, cycles_count, shift_name, mat_cost_total, overhead_cost_total, machine_amort_cost, mold_amort_cost)
                VALUES ($1, $2, $3, 'in_drying', $4, $5, 0, $6, $7, $8)
                RETURNING id
            `, [batchNumber, p.id, p.quantity, p.cycles, shiftName, totalAmortCost, totalMachineAmortCost, totalMoldAmortCost]);

            createdBatches.push({
                batchId: batchRes.rows[0].id,
                batchNumber: batchNumber,
                productId: p.id,
                quantity: p.quantity,
                fraction: volumeFraction,
                accumulatedCost: 0
            });
        }

        // 4. Распределяем и списываем реальное сырье по созданным партиям
        if (materialsUsed && materialsUsed.length > 0) {
            for (let mat of materialsUsed) {
                const priceObj = itemPrices.find(p => p.id == mat.id);
                const currentPrice = priceObj ? (parseFloat(priceObj.current_price) || 0) : 0;

                for (let batch of createdBatches) {
                    // Доля этого сырья, которая ушла конкретно на эту партию
                    const qtyForBatch = mat.qty * batch.fraction;
                    const costForBatch = qtyForBatch * currentPrice;

                    if (qtyForBatch > 0) {
                        batch.accumulatedCost += costForBatch;

                        // Списываем со Склада №1 в ИСТОРИЮ (inventory_movements)
                        await client.query(`
                            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
                            VALUES ($1, $2, 'production_expense', $3, 1, $4)
                        `, [mat.id, -qtyForBatch.toFixed(4), `Замес смены: Партия ${batch.batchNumber}`, batch.batchId]);
                    }
                }
            }
        }

        // 5. Сохраняем итоговую себестоимость партии и приходуем плитку на Склад №3
        for (let batch of createdBatches) {
            // Записываем стоимость сырья в партию
            await client.query(`UPDATE production_batches SET mat_cost_total = $1 WHERE id = $2`, [batch.accumulatedCost, batch.batchId]);

            // Приходуем саму плитку в Сушилку
            await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
                VALUES ($1, $2, 'production_receipt', $3, 3, $4)
            `, [batch.productId, batch.quantity, `Партия ${batch.batchNumber} (Сушка)`, batch.batchId]);
        }

        // 6. СПИСАНИЕ РЕСУРСА МАТРИЦ, СТАНКА И ПОДДОНОВ (АВТОМАТИЗАЦИЯ ТОиР)
        let totalShiftCycles = 0; // Копилка для всех ударов за смену

        for (let batch of createdBatches) {
            const origProd = products.find(p => p.id === batch.productId);

            if (origProd && origProd.cycles > 0) {
                totalShiftCycles += parseFloat(origProd.cycles); // Плюсуем удары в общую копилку

                // Обновляем износ конкретной МАТРИЦЫ
                if (origProd.mold_id) {
                    await client.query(`
                        UPDATE equipment 
                        SET current_cycles = COALESCE(current_cycles, 0) + $1 
                        WHERE id = $2 AND equipment_type = 'mold'
                    `, [origProd.cycles, origProd.mold_id]);
                }
            }
        }

        // Обновляем износ ГЛАВНОГО СТАНКА и ТЕХНОЛОГИЧЕСКИХ ПОДДОНОВ
        if (totalShiftCycles > 0) {
            await client.query(`
                UPDATE equipment 
                SET current_cycles = COALESCE(current_cycles, 0) + $1 
                WHERE equipment_type IN ('machine', 'pallets') AND status = 'active'
            `, [totalShiftCycles]);
        }

        await client.query('COMMIT');
        res.send('Производство зафиксировано');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ошибка фиксации:', err);
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// ==========================================
// ПОЛУЧЕНИЕ ИСТОРИИ ПАРТИЙ ЗА ДЕНЬ
// ==========================================
app.get('/api/production/history', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT pb.id, pb.batch_number, i.name as product_name, pb.planned_quantity, pb.mat_cost_total, pb.created_at
            FROM production_batches pb
            JOIN items i ON pb.product_id = i.id
            WHERE pb.created_at::date = $1
            ORDER BY pb.id DESC
        `, [req.query.date]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// ОТМЕНА (УДАЛЕНИЕ) ФОРМОВКИ И ВОЗВРАТ МАТЕРИАЛОВ + РЕСУРСА
// ==========================================
app.delete('/api/production/batch/:id', async (req, res) => {
    const batchId = req.params.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. УМНЫЙ ОТКАТ АМОРТИЗАЦИИ ПЕРЕД УДАЛЕНИЕМ
        const batchInfo = await client.query(`
            SELECT pb.cycles_count, i.mold_id 
            FROM production_batches pb
            JOIN items i ON pb.product_id = i.id
            WHERE pb.id = $1
        `, [batchId]);

        if (batchInfo.rows.length > 0) {
            const cyclesToRevert = parseFloat(batchInfo.rows[0].cycles_count) || 0;
            const moldId = batchInfo.rows[0].mold_id;

            if (cyclesToRevert > 0) {
                // Откатываем удары у матрицы (защита от минуса через GREATEST)
                if (moldId) {
                    await client.query(`
                        UPDATE equipment 
                        SET current_cycles = GREATEST(0, COALESCE(current_cycles, 0) - $1)
                        WHERE id = $2 AND equipment_type = 'mold'
                    `, [cyclesToRevert, moldId]);
                }

                // Откатываем удары у станка и поддонов
                await client.query(`
                    UPDATE equipment 
                    SET current_cycles = GREATEST(0, COALESCE(current_cycles, 0) - $1)
                    WHERE equipment_type IN ('machine', 'pallets') AND status = 'active'
                `, [cyclesToRevert]);
            }
        }

        // 2. Удаляем все движения по складам
        await client.query('DELETE FROM inventory_movements WHERE batch_id = $1', [batchId]);

        // 3. Удаляем саму партию
        await client.query('DELETE FROM production_batches WHERE id = $1', [batchId]);

        await client.query('COMMIT');
        res.send('Формовка отменена, материалы и ресурс оборудования возвращены');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// ==========================================
// ДЕТАЛИЗАЦИЯ СЫРЬЯ И ЗАТРАТ ПО КОНКРЕТНОЙ ПАРТИИ
// ==========================================
app.get('/api/production/batch/:id/materials', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT i.name, 
                   SUM(ABS(m.quantity)) as qty, 
                   i.unit, 
                   SUM(ABS(m.quantity) * i.current_price) as cost,
                   pb.planned_quantity,
                   pb.overhead_cost_total,
                   pb.machine_amort_cost,
                   pb.mold_amort_cost
            FROM inventory_movements m
            JOIN items i ON m.item_id = i.id
            JOIN production_batches pb ON m.batch_id = pb.id
            WHERE m.batch_id = $1 AND m.movement_type = 'production_expense'
            GROUP BY i.name, i.unit, pb.planned_quantity, pb.overhead_cost_total, pb.machine_amort_cost, pb.mold_amort_cost
            ORDER BY cost DESC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// 8. ЗАКУПКИ И ПРИХОД СЫРЬЯ (С УМНЫМ ОБНОВЛЕНИЕМ ЦЕН)
// ==========================================
app.post('/api/purchase', async (req, res) => {
    const { materialId, quantity, pricePerUnit, supplier } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Приходуем сырье на Склад №1
        const desc = `Приход от поставщика: ${supplier || 'Не указан'}`;
        await client.query(`
            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, created_at)
            VALUES ($1, $2, 'purchase_receipt', $3, 1, CURRENT_TIMESTAMP)
        `, [materialId, quantity, desc]);

        // 2. Фиксируем финансовый расход в кассе (Безнал по умолчанию, но можно будет сделать выбор)
        const totalCost = quantity * pricePerUnit;
        if (totalCost > 0) {
            await client.query(`
                 INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method)
                 VALUES ($1, 'expense', 'Закупка сырья', $2, 0, 'Безналичный расчет')
            `, [totalCost, desc]);

            // 3. САМАЯ ВАЖНАЯ МАГИЯ: АВТО-ОБНОВЛЕНИЕ ЦЕНЫ В СПРАВОЧНИКЕ!
            // Если мы купили сырье не бесплатно (цена > 0), обновляем его текущую стоимость
            if (pricePerUnit > 0) {
                await client.query(`
                    UPDATE items 
                    SET current_price = $1 
                    WHERE id = $2
                `, [pricePerUnit, materialId]);
            }
        }

        await client.query('COMMIT');
        res.send('Сырье успешно оприходовано, цена в справочнике обновлена!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ошибка закупки:', err.message);
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// ==========================================
// 2. СКЛАДСКАЯ ЛОГИСТИКА И ПРОИЗВОДСТВО
// ==========================================
// === БЛОК: СКЛАД (С учетом партий) ===
app.get('/api/inventory', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                w.id as warehouse_id, 
                w.name as warehouse_name, 
                i.id as item_id, 
                i.name as item_name, 
                i.category, 
                i.unit, 
                m.batch_id, 
                pb.batch_number, -- Подтягиваем красивый номер партии
                SUM(m.quantity) as total
            FROM inventory_movements m
            JOIN items i ON m.item_id = i.id
            JOIN warehouses w ON m.warehouse_id = w.id
            LEFT JOIN production_batches pb ON m.batch_id = pb.id
            GROUP BY w.id, w.name, i.id, i.name, i.category, i.unit, m.batch_id, pb.batch_number
            HAVING SUM(m.quantity) != 0
            ORDER BY w.id, i.category, i.name;
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send('Ошибка склада'); }
});

// === СКЛАД: ИНВЕНТАРИЗАЦИЯ (КОРРЕКТИРОВКА ОСТАТКОВ) ===
app.post('/api/inventory/audit', async (req, res) => {
    const { warehouseId, adjustments, description } = req.body;
    // adjustments - это массив: [{ itemId, batchId, diffQty }]
    // diffQty = Факт - План (если < 0, значит недостача; если > 0 - излишек)
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let adj of adjustments) {
            if (adj.diffQty !== 0) {
                const moveType = adj.diffQty > 0 ? 'audit_surplus' : 'audit_loss';
                const comment = description || (adj.diffQty > 0 ? 'Излишек по инвентаризации' : 'Недостача по инвентаризации');

                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [adj.itemId, adj.diffQty, moveType, comment, warehouseId, adj.batchId || null]);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// === СКЛАД: ПЕРЕМЕЩЕНИЕ В УЦЕНКУ ИЛИ УТИЛЬ ===
app.post('/api/inventory/scrap', async (req, res) => {
    const { itemId, batchId, warehouseId, targetWarehouseId, scrapQty, description } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Списываем с текущего склада
        await client.query(`
            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
            VALUES ($1, $2, 'scrap_writeoff', $3, $4, $5)
        `, [itemId, -Math.abs(scrapQty), description || 'Перемещение', warehouseId, batchId || null]);

        // 2. Зачисляем на целевой склад (5 - Уценка, 6 - Утиль)
        const destType = targetWarehouseId == 5 ? 'defect_receipt' : 'scrap_receipt';
        await client.query(`
            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [itemId, Math.abs(scrapQty), destType, description || 'Перемещение', targetWarehouseId, batchId || null]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// === СКЛАД: БЕЗВОЗВРАТНАЯ УТИЛИЗАЦИЯ (Очистка складов 5 и 6) ===
app.post('/api/inventory/dispose', async (req, res) => {
    const { itemId, batchId, warehouseId, disposeQty, description } = req.body;
    try {
        await pool.query(`
            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
            VALUES ($1, $2, 'permanent_disposal', $3, $4, $5)
        `, [itemId, -Math.abs(disposeQty), description || 'Вывоз на свалку / Уничтожение', warehouseId, batchId || null]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ==========================================
// 6. УМНОЕ ПРОИЗВОДСТВО С ПАРТИЯМИ И СЕБЕСТОИМОСТЬЮ
// ==========================================
app.post('/api/produce', async (req, res) => {
    const { tileId, quantity, moisture = 0, defect = 0 } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Получаем рецепт И ТЕКУЩИЕ ЦЕНЫ материалов для расчета себестоимости
        const recipeRes = await client.query(`
            SELECT r.material_id, r.quantity_per_unit, i.name, i.current_price 
            FROM recipes r 
            JOIN items i ON r.material_id = i.id 
            WHERE r.product_id = $1
        `, [tileId]);

        if (recipeRes.rows.length === 0) throw new Error('Нет рецепта для продукции!');

        // 2. Генерируем номер партии (Дата + Порядковый номер за сегодня)
        const dateStr = new Date().toISOString().split('T')[0];
        const countRes = await client.query(`SELECT COUNT(*) FROM production_batches WHERE created_at::date = CURRENT_DATE`);
        const batchNum = `${dateStr}-${(parseInt(countRes.rows[0].count) + 1).toString().padStart(2, '0')}`;

        // 3. Считаем ПЛАНОВУЮ стоимость материалов на этот объем
        let totalMatCost = 0;
        const grossQuantity = quantity * (1 + (defect / 100));

        // Создаем запись о партии
        const batchRes = await client.query(`
            INSERT INTO production_batches (batch_number, product_id, planned_quantity, mat_cost_total, status)
            VALUES ($1, $2, $3, 0, 'in_drying') RETURNING id
        `, [batchNum, tileId, quantity]);
        const batchId = batchRes.rows[0].id;

        // 4. Списание материалов и накопление стоимости
        for (let ing of recipeRes.rows) {
            let needed = ing.quantity_per_unit * grossQuantity;
            if (ing.name.toLowerCase().includes('песок') && moisture > 0) {
                needed = needed / (1 - (moisture / 100));
            }

            const cost = needed * (parseFloat(ing.current_price) || 0);
            totalMatCost += cost;

            await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
                VALUES ($1, $2, 'production_expense', $3, 1, $4)
            `, [ing.material_id, -needed.toFixed(4), `Партия ${batchNum}`, batchId]);
        }

        // Обновляем итоговую стоимость материалов в партии
        await client.query(`UPDATE production_batches SET mat_cost_total = $1 WHERE id = $2`, [totalMatCost, batchId]);

        // 5. Приход в сушилку
        await client.query(`
            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
            VALUES ($1, $2, 'production_receipt', $3, 3, $4)
        `, [tileId, quantity, `Партия ${batchNum} (Сушка)`, batchId]);

        await client.query('COMMIT');
        res.json({ message: 'Партия запущена', batchNumber: batchNum });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// Получить партии в сушилке (для распалубки)
app.get('/api/production/in-drying', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT pb.id, pb.batch_number, pb.product_id, i.name as product_name, pb.planned_quantity, pb.created_at
            FROM production_batches pb
            JOIN items i ON pb.product_id = i.id
            WHERE pb.status = 'in_drying'
            ORDER BY pb.created_at ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Умная Распалубка с закрытием партии
app.post('/api/move-wip', async (req, res) => {
    const { tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete, batchId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const totalActual = parseFloat(goodQty || 0) + parseFloat(grade2Qty || 0) + parseFloat(scrapQty || 0);

        // ЛОГИКА ЗАКРЫТИЯ: закрываем, если стоит галочка ИЛИ если по факту вытащили всё, что числилось
        const finalIsComplete = isComplete || (totalActual >= parseFloat(currentWipQty));

        // Если закрываем полностью, списываем из сушилки ВЕСЬ числящийся остаток (чтобы не было пустых хвостов).
        // Но если получилось больше плана, списываем фактическое количество.
        const expenseQty = finalIsComplete ? Math.max(parseFloat(currentWipQty), totalActual) : totalActual;

        if (expenseQty > 0) {
            await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
                                VALUES ($1, $2, 'wip_expense', 'Выгрузка партии', 3, $3)`, [tileId, -expenseQty, batchId]);
        }

        // 2. Приход на склады
        if (parseFloat(goodQty) > 0) await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, warehouse_id, batch_id) VALUES ($1, $2, 'finished_receipt', 4, $3)`, [tileId, goodQty, batchId]);
        if (parseFloat(grade2Qty) > 0) await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, warehouse_id, batch_id) VALUES ($1, $2, 'defect_receipt', 5, $3)`, [tileId, grade2Qty, batchId]);
        if (parseFloat(scrapQty) > 0) await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, warehouse_id, batch_id) VALUES ($1, $2, 'scrap_receipt', 6, $3)`, [tileId, scrapQty, batchId]);

        // 3. ЗАКРЫВАЕМ ПАРТИЮ И ФИКСИРУЕМ ВЫХОД
        const status = finalIsComplete ? 'completed' : 'in_drying';

        await client.query(`
            UPDATE production_batches 
            SET actual_good_qty = COALESCE(actual_good_qty, 0) + $1, 
                actual_grade2_qty = COALESCE(actual_grade2_qty, 0) + $2, 
                actual_scrap_qty = COALESCE(actual_scrap_qty, 0) + $3, 
                status = $4
            WHERE id = $5
        `, [goodQty, grade2Qty, scrapQty, status, batchId]);

        await client.query('COMMIT');
        res.send('Партия успешно закрыта');
    } catch (err) { await client.query('ROLLBACK'); res.status(500).send(err.message); } finally { client.release(); }
});

// МАРШРУТ ДЛЯ ГРАФИКА АНАЛИТИКИ (ПОЛНАЯ СЕБЕСТОИМОСТЬ)
app.get('/api/analytics/cost-deviation', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                created_at::date as date,
                batch_number,
                i.name as product_name,
                -- Идеальная себестоимость (Сырье + Труд + Накладные делим на ПЛАНОВЫЙ объем)
                ((pb.mat_cost_total + COALESCE(pb.labor_cost_total, 0) + COALESCE(pb.overhead_cost_total, 0)) / NULLIF(pb.planned_quantity, 0)) as planned_unit_cost,
                -- Реальная себестоимость (Все те же затраты, но делим только на ГОДНУЮ плитку)
                ((pb.mat_cost_total + COALESCE(pb.labor_cost_total, 0) + COALESCE(pb.overhead_cost_total, 0)) / NULLIF(pb.actual_good_qty, 0)) as actual_unit_cost
            FROM production_batches pb
            LEFT JOIN items i ON pb.product_id = i.id
            WHERE pb.status = 'completed'
            ORDER BY pb.created_at ASC
            LIMIT 30
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// 3. СПРАВОЧНИКИ (Умный поиск и фильтрация)
// ==========================================

// Получение списка уникальных категорий для фильтров
app.get('/api/categories', async (req, res) => {
    try {
        const result = await pool.query(`SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category != '' ORDER BY category`);
        res.json(result.rows.map(r => r.category));
    } catch (err) { res.status(500).send(err.message); }
});

// Умный поиск и получение товаров
app.get('/api/items', async (req, res) => {
    const { page = 1, limit = 50, search = '', item_type = '', category = '' } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    let params = [];
    let paramIndex = 1;

    // Фильтр по тексту (Название или Категория)
    if (search) {
        whereClause += ` AND (name ILIKE $${paramIndex} OR category ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
    }
    // Фильтр по типу (Сырье / Продукция)
    if (item_type) {
        whereClause += ` AND item_type = $${paramIndex}`;
        params.push(item_type);
        paramIndex++;
    }
    // Фильтр по конкретной категории
    if (category) {
        whereClause += ` AND category = $${paramIndex}`;
        params.push(category);
        paramIndex++;
    }

    try {
        const countRes = await pool.query(`SELECT COUNT(*) FROM items ${whereClause}`, params);
        const totalItems = parseInt(countRes.rows[0].count);
        // Выводим с сортировкой: сначала Тип, затем Категория, затем Алфавит
        const dataRes = await pool.query(`SELECT * FROM items ${whereClause} ORDER BY item_type, category, name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`, [...params, limit, offset]);

        res.json({
            data: dataRes.rows,
            total: totalItems,
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalItems / limit) || 1
        });
    } catch (err) { res.status(500).send(err.message); }
});

// Добавление новой позиции (С привязкой Матрицы и ГОСТ/ТУ)
app.post('/api/items', async (req, res) => {
    const { name, item_type, category, unit, price, weight, qty_per_cycle, mold_id, gost_mark } = req.body;
    try {
        await pool.query(`
            INSERT INTO items (name, item_type, category, unit, current_price, weight_kg, qty_per_cycle, mold_id, gost_mark) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [name, item_type, category, unit, price, weight, qty_per_cycle || 1, mold_id || null, gost_mark || '']);
        res.send('Добавлено');
    } catch (err) { res.status(500).send(err.message); }
});

// Обновление существующей позиции (С привязкой Матрицы и ГОСТ/ТУ)
app.put('/api/items/:id', async (req, res) => {
    const { name, item_type, category, unit, price, weight, qty_per_cycle, mold_id, gost_mark } = req.body;
    try {
        await pool.query(`
            UPDATE items 
            SET name=$1, item_type=$2, category=$3, unit=$4, current_price=$5, weight_kg=$6, qty_per_cycle=$7, mold_id=$8, gost_mark=$9 
            WHERE id=$10
        `, [name, item_type, category, unit, price, weight, qty_per_cycle || 1, mold_id || null, gost_mark || '', req.params.id]);
        res.send('Обновлено');
    } catch (err) { res.status(500).send(err.message); }
});

// Удаление позиции
app.delete('/api/items/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM items WHERE id = $1`, [req.params.id]);
        res.send('Удалено');
    } catch (err) { res.status(500).send('Товар используется на складе или в рецептах!'); }
});

// ==========================================
// 4. РЕЦЕПТУРЫ
// ==========================================
app.get('/api/recipes/:productId', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.id, r.material_id, r.quantity_per_unit, i.name as material_name, i.unit, i.current_price 
            FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1
        `, [req.params.productId]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/recipes/save', async (req, res) => {
    const { productId, productName, ingredients, force } = req.body;
    const client = await pool.connect();
    try {
        let newSand = ingredients.find(i => i.name.toLowerCase().includes('песок'))?.qty || 0;
        let newStone = ingredients.find(i => i.name.toLowerCase().includes('щебень'))?.qty || 0;

        if (!force) {
            const match = productName.match(/(\d\.[А-Я]+\.\d)/);
            if (match) {
                const baseForm = match[0];
                const checkRes = await client.query(`
                    SELECT r.quantity_per_unit, i.name 
                    FROM recipes r JOIN items i ON r.material_id = i.id JOIN items p ON r.product_id = p.id
                    WHERE p.name LIKE $1 AND p.id != $2 AND (i.name ILIKE '%песок%' OR i.name ILIKE '%щебень%') LIMIT 10
                `, [`%${baseForm}%`, productId]);

                let oldSand = checkRes.rows.find(r => r.name.toLowerCase().includes('песок'))?.quantity_per_unit || newSand;
                let oldStone = checkRes.rows.find(r => r.name.toLowerCase().includes('щебень'))?.quantity_per_unit || newStone;

                if (Math.abs(newSand - oldSand) > oldSand * 0.1 || Math.abs(newStone - oldStone) > oldStone * 0.1) {
                    return res.status(400).json({ warning: `⚠️ ВНИМАНИЕ! Вы указали Песок: ${newSand}кг, Щебень: ${newStone}кг.\nНо у аналогичной плитки (${baseForm}) стандартом идет Песок: ${oldSand}кг, Щебень: ${oldStone}кг.\nВозможно, ошибка в данных. Сохранить принудительно?` });
                }
            }
        }

        await client.query('BEGIN');
        await client.query('DELETE FROM recipes WHERE product_id = $1', [productId]);
        for (let ing of ingredients) {
            await client.query(`INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`, [productId, ing.materialId, ing.qty]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// ==========================================
// МАССОВОЕ КОПИРОВАНИЕ РЕЦЕПТА (ШАБЛОНЫ)
// ==========================================
app.post('/api/recipes/mass-copy', async (req, res) => {
    const { sourceProductId, targetProductIds } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Получаем эталонный рецепт
        const sourceRecipeRes = await client.query(`SELECT material_id, quantity_per_unit FROM recipes WHERE product_id = $1`, [sourceProductId]);
        const sourceRecipe = sourceRecipeRes.rows;

        if (sourceRecipe.length === 0) throw new Error('Эталонный рецепт пуст!');

        // 2. Применяем ко всем целевым товарам
        for (let targetId of targetProductIds) {
            // Удаляем старый рецепт у цели
            await client.query('DELETE FROM recipes WHERE product_id = $1', [targetId]);

            // Вставляем копию эталона
            for (let ing of sourceRecipe) {
                await client.query(`
                    INSERT INTO recipes (product_id, material_id, quantity_per_unit) 
                    VALUES ($1, $2, $3)
                `, [targetId, ing.material_id, ing.quantity_per_unit]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, message: `Шаблон применен к ${targetProductIds.length} позициям.` });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// ==========================================
// АВТО-СОЗДАНИЕ АДМИНИСТРАТОРА ПРИ ЗАПУСКЕ
// ==========================================
pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'employee',
        full_name VARCHAR(150)
    );
    INSERT INTO users (username, password_hash, role, full_name) 
    VALUES ('admin', '12345', 'admin', 'Директор (Администратор)')
    ON CONFLICT (username) 
    DO UPDATE SET password_hash = '12345', role = 'admin', full_name = 'Директор (Администратор)';
`).then(() => console.log('✅ База пользователей проверена. Логин: admin, Пароль: 12345'))
    .catch(err => console.error('❌ Ошибка создания пользователя:', err.message));

// ==========================================
// УМНАЯ СИНХРОНИЗАЦИЯ РЕЦЕПТОВ ПО ВЫБРАННЫМ ID
// ==========================================
app.post('/api/recipes/sync-category', async (req, res) => {
    // Теперь принимаем конкретные ID товаров (targetProductIds)
    const { targetProductIds, materials } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        if (!targetProductIds || targetProductIds.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ message: 'Не выбраны товары для синхронизации.' });
        }

        // Обновляем базовые материалы для каждого выбранного товара
        for (let targetId of targetProductIds) {
            for (let mat of materials) {
                const checkRes = await client.query(
                    `SELECT 1 FROM recipes WHERE product_id = $1 AND material_id = $2`,
                    [targetId, mat.materialId]
                );

                if (checkRes.rows.length > 0) {
                    await client.query(
                        `UPDATE recipes SET quantity_per_unit = $1 WHERE product_id = $2 AND material_id = $3`,
                        [mat.qty, targetId, mat.materialId]
                    );
                } else {
                    await client.query(
                        `INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`,
                        [targetId, mat.materialId, mat.qty]
                    );
                }
            }
        }

        await client.query('COMMIT');
        res.json({ message: `Успешно применено к ${targetProductIds.length} позициям.` });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// ==========================================
// 9. КАДРЫ, ТАБЕЛЬ И ЗАРПЛАТА
// ==========================================

// Получить список всех сотрудников
app.get('/api/employees', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM employees ORDER BY department, full_name`);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Добавить сотрудника
app.post('/api/employees', async (req, res) => {
    const { full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status } = req.body;
    try {
        await pool.query(`
            INSERT INTO employees (full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [full_name, position, department, schedule_type, salary_cash || 0, salary_official || 20000, tax_rate || 13, tax_withheld || 2600, prev_balance || 0, status || 'active']);
        res.send('Сотрудник добавлен');
    } catch (err) { res.status(500).send(err.message); }
});

// Обновить сотрудника (с защитой прошлых месяцев и остатком)
app.put('/api/employees/:id', async (req, res) => {
    const { full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status } = req.body;
    const currentMonthStr = new Date().toISOString().substring(0, 7);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            UPDATE employees SET full_name=$1, position=$2, department=$3, schedule_type=$4, salary_cash=$5, salary_official=$6, tax_rate=$7, tax_withheld=$8, prev_balance=$9, status=$10
            WHERE id=$11
        `, [full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status, req.params.id]);

        await client.query(`
            UPDATE monthly_salary_stats 
            SET salary_cash=$1, salary_official=$2, tax_rate=$3, tax_withheld=$4
            WHERE employee_id=$5 AND month_str >= $6
        `, [salary_cash, salary_official, tax_rate, tax_withheld, req.params.id, currentMonthStr]);

        await client.query('COMMIT');
        res.send('Данные обновлены');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// Удаление сотрудника (с защитой истории)
app.delete('/api/employees/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM employees WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        // Ловим ошибку связи внешних ключей (если есть выплаты или табели)
        if (err.code === '23503') {
            res.status(400).send('Невозможно удалить: у сотрудника есть история зарплат или табелей. Он скрыт из активных списков статусом "Уволен".');
        } else {
            res.status(500).send(err.message);
        }
    }
});

// === ДОП. ОПЕРАЦИИ (ГСМ, ЗАЙМЫ, ШТРАФЫ И БОНУСЫ) ===
app.get('/api/salary/adjustments', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM salary_adjustments WHERE month_str = $1`, [req.query.monthStr]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/salary/adjustments', async (req, res) => {
    const { employee_id, month_str, amount, description } = req.body;
    try {
        await pool.query(`INSERT INTO salary_adjustments (employee_id, month_str, amount, description) VALUES ($1, $2, $3, $4)`, [employee_id, month_str, amount, description]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/salary/adjustments/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM salary_adjustments WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// Получить "слепки" окладов на конкретный месяц (Авто-создание если их нет)
app.get('/api/salary/stats', async (req, res) => {
    const { year, month } = req.query;
    const monthStr = `${year}-${month}`;
    try {
        // Если мы впервые открываем этот месяц, копируем текущие оклады из профиля сотрудников
        await pool.query(`
            INSERT INTO monthly_salary_stats (employee_id, month_str, salary_cash, salary_official, tax_rate, tax_withheld)
            SELECT id, $1, salary_cash, salary_official, tax_rate, tax_withheld FROM employees
            ON CONFLICT (employee_id, month_str) DO NOTHING
        `, [monthStr]);

        const result = await pool.query(`SELECT * FROM monthly_salary_stats WHERE month_str = $1`, [monthStr]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Оплата официальных налогов по безналу
app.post('/api/salary/pay-taxes', async (req, res) => {
    const { monthStr, amount } = req.body;
    try {
        await pool.query(`
            INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method)
            VALUES ($1, 'expense', 'Налоги и Взносы', $2, 0, 'Безналичный расчет')
        `, [amount, `Уплата налогов с ФОТ за ${monthStr}`]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// Получить табель на конкретную дату
app.get('/api/timesheet', async (req, res) => {
    const { date } = req.query;
    try {
        // Вытягиваем всех сотрудников и их отметки на этот день (если они есть)
        const result = await pool.query(`
            SELECT e.id as employee_id, e.full_name, e.position, e.department, e.schedule_type, t.status 
            FROM employees e
            LEFT JOIN timesheets t ON e.id = t.employee_id AND t.record_date = $1
            ORDER BY e.department, e.full_name
        `, [date]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Сохранить табель за день
app.post('/api/timesheet', async (req, res) => {
    const { date, records } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let rec of records) {
            // Используем UPSERT (вставить или обновить, если уже есть отметка на этот день)
            await client.query(`
                INSERT INTO timesheets (employee_id, record_date, status)
                VALUES ($1, $2, $3)
                ON CONFLICT (employee_id, record_date) 
                DO UPDATE SET status = EXCLUDED.status
            `, [rec.employee_id, date, rec.status]);
        }
        await client.query('COMMIT');
        res.json({ message: 'Табель успешно сохранен!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// Получить табель на ВЕСЬ МЕСЯЦ (с деньгами)
app.get('/api/timesheet/month', async (req, res) => {
    const { year, month } = req.query;
    try {
        const startDate = `${year}-${month}-01`;
        const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`; // ЖЕЛЕЗОБЕТОННАЯ ДАТА

        // ИСПОЛЬЗУЕМ TO_CHAR ДЛЯ ЗАЩИТЫ ОТ СДВИГА ЧАСОВЫХ ПОЯСОВ
        const result = await pool.query(`
            SELECT employee_id, TO_CHAR(record_date, 'YYYY-MM-DD') as record_date, status, bonus, penalty
            FROM timesheets
            WHERE record_date >= $1 AND record_date <= $2
        `, [startDate, endDate]);

        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Быстрое сохранение статуса одной ячейки (с премией и штрафом)
app.post('/api/timesheet/cell', async (req, res) => {
    const { employee_id, date, status, bonus, penalty } = req.body;
    try {
        await pool.query(`
            INSERT INTO timesheets (employee_id, record_date, status, bonus, penalty)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (employee_id, record_date) 
            DO UPDATE SET status = EXCLUDED.status, bonus = EXCLUDED.bonus, penalty = EXCLUDED.penalty
        `, [employee_id, date, status, bonus || 0, penalty || 0]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// ИНТЕГРАЦИЯ: ПРОИЗВОДСТВО -> ЗАРПЛАТА (СДЕЛЬНАЯ)
// ==========================================

// Получить статистику производства (Годная продукция) за конкретный день
app.get('/api/production/daily-stats', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT SUM(actual_good_qty) as total_good 
            FROM production_batches 
            WHERE created_at::date = $1 AND status = 'completed'
        `, [req.query.date]);
        res.json({ total: result.rows[0].total_good || 0 });
    } catch (err) { res.status(500).send(err.message); }
});

// Получить табель на ВЕСЬ МЕСЯЦ (теперь с КТУ и кастомной ставкой)
app.get('/api/timesheet/month', async (req, res) => {
    const { year, month } = req.query;
    try {
        const startDate = `${year}-${month}-01`;
        const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;

        const result = await pool.query(`
            SELECT employee_id, TO_CHAR(record_date, 'YYYY-MM-DD') as record_date, status, bonus, penalty, custom_rate, ktu
            FROM timesheets
            WHERE record_date >= $1 AND record_date <= $2
        `, [startDate, endDate]);

        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// === МАССОВОЕ НАЧИСЛЕНИЕ СДЕЛЬНОЙ ПРЕМИИ (С КТУ И ГИБКОЙ СТАВКОЙ) ===
app.post('/api/timesheet/mass-bonus', async (req, res) => {
    const { date, empData, totalBonusFund } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Начисляем премию и индивидуальные ставки рабочим
        for (let emp of empData) {
            await client.query(`
                INSERT INTO timesheets (employee_id, record_date, status, bonus, custom_rate, ktu)
                VALUES ($1, $2, 'present', $3, $4, $5)
                ON CONFLICT (employee_id, record_date) 
                DO UPDATE SET 
                    bonus = timesheets.bonus + EXCLUDED.bonus,
                    custom_rate = EXCLUDED.custom_rate,
                    ktu = EXCLUDED.ktu
            `, [emp.id, date, emp.bonus, emp.custom_rate, emp.ktu]);
        }

        // 2. УМНАЯ СЕБЕСТОИМОСТЬ: Распределяем фонд на партии
        if (totalBonusFund > 0) {
            const batchesRes = await client.query(`
                SELECT id, planned_quantity FROM production_batches 
                WHERE created_at::date = $1
            `, [date]);

            const batches = batchesRes.rows;
            const totalProductsToday = batches.reduce((sum, b) => sum + parseFloat(b.planned_quantity), 0);

            if (totalProductsToday > 0) {
                for (let batch of batches) {
                    const fraction = parseFloat(batch.planned_quantity) / totalProductsToday;
                    const batchLaborCost = totalBonusFund * fraction;

                    await client.query(`
                        UPDATE production_batches 
                        SET labor_cost_total = COALESCE(labor_cost_total, 0) + $1
                        WHERE id = $2
                    `, [batchLaborCost, batch.id]);
                }
            }
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// Получить все выплаты (авансы) за выбранный месяц (с детализацией)
app.get('/api/salary/payments', async (req, res) => {
    const { year, month } = req.query;
    try {
        const startDate = `${year}-${month}-01`;
        const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;

        const result = await pool.query(`
            SELECT id, employee_id, amount, TO_CHAR(payment_date, 'YYYY-MM-DD') as payment_date, description
            FROM salary_payments
            WHERE payment_date >= $1 AND payment_date <= $2
            ORDER BY payment_date ASC
        `, [startDate, endDate]);

        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// === ВЫПЛАТА ЗАРПЛАТЫ / АВАНСА С КОРРЕКТИРОВКОЙ БАЛАНСА ===
app.post('/api/salary/pay', async (req, res) => {
    const { employee_id, amount, date, description, account_id } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Создаем транзакцию в Финансах и ПОЛУЧАЕМ ЕЁ ID
        const transRes = await client.query(`
            INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id)
            VALUES ($1, 'expense', 'Зарплата и Авансы', $2, 0, 'Выплата из системы', $3)
            RETURNING id
        `, [amount, `Выплата: ${description}`, account_id]);

        const linkedId = transRes.rows[0].id;

        // 2. Фиксируем выплату и ПРИВЯЗЫВАЕМ ID ТРАНЗАКЦИИ
        await client.query(`
            INSERT INTO salary_payments (employee_id, amount, payment_date, description, account_id, linked_transaction_id)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [employee_id, amount, date, description, account_id, linkedId]);

        await client.query(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [amount, account_id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// === УДАЛЕНИЕ ВЫПЛАТЫ ИЗ КАДРОВ (УМНОЕ) ===
app.delete('/api/salary/payment/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Находим саму выплату в базе
        const payRes = await client.query('SELECT * FROM salary_payments WHERE id = $1', [req.params.id]);
        if (payRes.rows.length === 0) throw new Error('Выплата не найдена');
        const payment = payRes.rows[0];

        // 2. Если у выплаты ЕСТЬ привязанная финансовая транзакция (новая логика)
        if (payment.linked_transaction_id) {
            const transRes = await client.query('SELECT amount, transaction_type, account_id FROM transactions WHERE id = $1', [payment.linked_transaction_id]);

            // Если транзакция еще существует в Финансах - возвращаем баланс и удаляем её
            if (transRes.rows.length > 0) {
                const trans = transRes.rows[0];
                if (trans.account_id) {
                    const balanceChange = trans.transaction_type === 'income' ? -trans.amount : trans.amount;
                    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, trans.account_id]);
                }
                await client.query('DELETE FROM transactions WHERE id = $1', [payment.linked_transaction_id]);
            }
        }

        // 3. В любом случае (и для старых, и для новых) удаляем саму запись из ведомости зарплат
        await client.query('DELETE FROM salary_payments WHERE id = $1', [req.params.id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// ==========================================
// ЗАКРЫТИЕ МЕСЯЦА (ПЕРЕНОС ОСТАТКОВ)
// ==========================================
app.post('/api/salary/close-month', async (req, res) => {
    const { balances } = req.body; // Получаем массив { empId, balance }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let b of balances) {
            // Перезаписываем остаток в профиле сотрудника на новую сумму
            await client.query('UPDATE employees SET prev_balance = $1 WHERE id = $2', [b.balance, b.empId]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// === ФУНКЦИЯ: ПЕРЕВОД СУММЫ ПРОПИСЬЮ (ДЛЯ СЧЕТА) ===
function numberToWordsRu(num) {
    const units = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
    const unitsFem = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
    const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
    const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
    const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

    function getWord(n, gender) {
        let res = '';
        if (n >= 100) { res += hundreds[Math.floor(n / 100)] + ' '; n %= 100; }
        if (n >= 10 && n <= 19) { res += teens[n - 10] + ' '; return res; }
        if (n >= 20) { res += tens[Math.floor(n / 10)] + ' '; n %= 10; }
        if (n > 0) { res += (gender === 0 ? unitsFem[n] : units[n]) + ' '; }
        return res;
    }

    const rubles = Math.floor(num);
    const kopecks = Math.round((num - rubles) * 100);
    let words = '';

    if (rubles === 0) { words = 'Ноль '; } else {
        let r = rubles;
        const millions = Math.floor(r / 1000000); r %= 1000000;
        const thousands = Math.floor(r / 1000); r %= 1000;
        const unitsPart = r;

        if (millions > 0) words += getWord(millions, 1) + 'миллион' + (millions % 10 === 1 && millions % 100 !== 11 ? '' : (millions % 10 >= 2 && millions % 10 <= 4 && (millions % 100 < 10 || millions % 100 >= 20) ? 'а' : 'ов')) + ' ';
        if (thousands > 0) words += getWord(thousands, 0) + 'тысяч' + (thousands % 10 === 1 && thousands % 100 !== 11 ? 'а' : (thousands % 10 >= 2 && thousands % 10 <= 4 && (thousands % 100 < 10 || thousands % 100 >= 20) ? 'и' : '')) + ' ';
        if (unitsPart > 0) words += getWord(unitsPart, 1);
    }

    words += 'рубл' + (rubles % 10 === 1 && rubles % 100 !== 11 ? 'ь' : (rubles % 10 >= 2 && rubles % 10 <= 4 && (rubles % 100 < 10 || rubles % 100 >= 20) ? 'я' : 'ей'));
    words = words.charAt(0).toUpperCase() + words.slice(1);
    return words.trim() + ' ' + String(kopecks).padStart(2, '0') + ' копеек';
}

// === ФИНАНСЫ: КОНТРОЛЬ ОЖИДАЕМЫХ ПЛАТЕЖЕЙ (СЧЕТА) ===

app.get('/api/invoices', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT i.*, c.name as counterparty_name,
                   TO_CHAR(i.created_at, 'DD.MM.YYYY') as date_formatted
            FROM invoices i
            JOIN counterparties c ON i.counterparty_id = c.id
            WHERE i.status = 'pending'
            ORDER BY i.id DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/invoices', async (req, res) => {
    const { cp_id, amount, desc, num } = req.body;
    try {
        await pool.query(`
            INSERT INTO invoices (counterparty_id, invoice_number, amount, description, status)
            VALUES ($1, $2, $3, $4, 'pending')
        `, [cp_id, num, amount, desc]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/invoices/:id/pay', async (req, res) => {
    const { account_id } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const invRes = await client.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
        const inv = invRes.rows[0];
        if (!inv) throw new Error('Счет не найден');

        // 1. Закрываем счет
        await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [req.params.id]);

        // 2. Создаем приходную операцию (доход)
        const vatAmount = (inv.amount * 22) / 122;
        const desc = `Оплата по счету №${inv.invoice_number}. ${inv.description}`;

        await client.query(`
            INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id)
            VALUES ($1, 'income', 'Продажа продукции', $2, $3, 'Безналичный расчет', $4, $5)
        `, [inv.amount, desc, vatAmount, account_id, inv.counterparty_id]);

        // 3. Обновляем баланс банка
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [inv.amount, account_id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

app.delete('/api/invoices/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// === ГЕНЕРАЦИЯ ПЕЧАТНОЙ ФОРМЫ: ПАСПОРТ ПАРТИИ (А5) ===
app.get('/print/passport', async (req, res) => {
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
        res.status(500).send('Ошибка генерации паспорта: ' + err.message);
    }
});

// ==========================================
// 10. ОБОРУДОВАНИЕ И МАТРИЦЫ (ТОиР)
// ==========================================

// Получить список всего оборудования
app.get('/api/equipment', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM equipment ORDER BY equipment_type, name`);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Добавить новое оборудование
app.post('/api/equipment', async (req, res) => {
    const { name, equipment_type, purchase_cost, planned_cycles, current_cycles, qty_per_cycle, status } = req.body;
    try {
        await pool.query(`
            INSERT INTO equipment (name, equipment_type, purchase_cost, planned_cycles, current_cycles, qty_per_cycle, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [name, equipment_type, purchase_cost, planned_cycles, current_cycles || 0, qty_per_cycle, status || 'active']);
        res.send('Оборудование добавлено');
    } catch (err) { res.status(500).send(err.message); }
});

// Обновить оборудование
app.put('/api/equipment/:id', async (req, res) => {
    const { name, equipment_type, purchase_cost, planned_cycles, current_cycles, qty_per_cycle, status } = req.body;
    try {
        await pool.query(`
            UPDATE equipment 
            SET name=$1, equipment_type=$2, purchase_cost=$3, planned_cycles=$4, current_cycles=$5, qty_per_cycle=$6, status=$7 
            WHERE id=$8
        `, [name, equipment_type, purchase_cost, planned_cycles, current_cycles || 0, qty_per_cycle, status, req.params.id]);
        res.send('Оборудование обновлено');
    } catch (err) { res.status(500).send(err.message); }
});

// === ТОиР: ФИКСАЦИЯ РЕМОНТА ИЛИ РЕСТАВРАЦИИ ===
app.post('/api/equipment/:id/maintenance', async (req, res) => {
    const { amount, description, account_id, reset_cycles } = req.body;
    const equipId = req.params.id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Списываем деньги со счета (если ремонт был платным)
        if (amount > 0 && account_id) {
            await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, account_id]);

            // 2. Создаем транзакцию (расход), жестко привязанную к этому станку/матрице
            await client.query(`
                INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, equipment_id)
                VALUES ($1, 'expense', 'Ремонт и ТО оборудования', $2, 'Безналичный расчет', $3, $4)
            `, [amount, description, account_id, equipId]);
        }

        // 3. Если это реставрация матрицы — обнуляем счетчик ударов (даем вторую жизнь)
        if (reset_cycles) {
            await client.query('UPDATE equipment SET current_cycles = 0 WHERE id = $1', [equipId]);
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// Удалить оборудование с умной защитой
app.delete('/api/equipment/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM equipment WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        // Ловим ошибку базы данных (если матрица уже привязана к плитке)
        if (err.code === '23503') {
            res.status(400).send('Невозможно удалить: это оборудование уже привязано к продукции в Справочнике. Рекомендуется изменить статус на "Списано".');
        } else {
            res.status(500).send(err.message);
        }
    }
});

// === ТОиР: ФИКСАЦИЯ РЕМОНТА ИЛИ РЕСТАВРАЦИИ ===
app.post('/api/equipment/:id/maintenance', async (req, res) => {
    const { amount, description, account_id, reset_cycles } = req.body;
    const equipId = req.params.id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Списываем деньги со счета (если ремонт был платным)
        if (amount > 0 && account_id) {
            await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, account_id]);

            // 2. Создаем транзакцию (расход), жестко привязанную к этому станку/матрице
            await client.query(`
                INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, equipment_id)
                VALUES ($1, 'expense', 'Ремонт и ТО оборудования', $2, 'Безналичный расчет', $3, $4)
            `, [amount, description, account_id, equipId]);
        }

        // 3. Если это реставрация матрицы — обнуляем счетчик ударов (даем вторую жизнь)
        if (reset_cycles) {
            await client.query('UPDATE equipment SET current_cycles = 0 WHERE id = $1', [equipId]);
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// ==============================================================================
// АНАЛИТИКА: КОНСТРУКТОР СЕБЕСТОИМОСТИ
// ==============================================================================
app.post('/api/analytics/cost-constructor', async (req, res) => {
    const { startDate, endDate } = req.body;
    const client = await pool.connect();
    try {
        // 1. Получаем все расходы за выбранный период
        const expRes = await client.query(`
            SELECT id, category, description, amount, created_at::date as date
            FROM transactions
            WHERE transaction_type = 'expense'
              AND created_at::date >= $1 AND created_at::date <= $2
            ORDER BY created_at DESC
        `, [startDate, endDate]);

        // 2. Считаем общее количество отработанных циклов за этот же период
        const cyclesRes = await client.query(`
            SELECT COALESCE(SUM(cycles_count), 0) as total_cycles
            FROM production_batches
            WHERE status = 'completed'
              AND created_at::date >= $1 AND created_at::date <= $2
        `, [startDate, endDate]);

        res.json({
            expenses: expRes.rows,
            totalCycles: parseFloat(cyclesRes.rows[0].total_cycles)
        });
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// === OMS: ПОЛУЧИТЬ ДЕТАЛИ ЗАКАЗА ДЛЯ УПРАВЛЕНИЯ ===
app.get('/api/sales/orders/:id', async (req, res) => {
    try {
        const orderRes = await pool.query(`
            SELECT o.*, c.name as client_name 
            FROM client_orders o 
            LEFT JOIN counterparties c ON o.counterparty_id = c.id 
            WHERE o.id = $1
        `, [req.params.id]);

        if (orderRes.rows.length === 0) return res.status(404).send('Заказ не найден');

        const itemsRes = await pool.query(`
            SELECT coi.*, i.name, i.unit 
            FROM client_order_items coi 
            JOIN items i ON coi.item_id = i.id 
            WHERE coi.order_id = $1
        `, [req.params.id]);

        res.json({ order: orderRes.rows[0], items: itemsRes.rows });
    } catch (err) { res.status(500).send(err.message); }
});

// === OMS: ЧАСТИЧНАЯ ИЛИ ПОЛНАЯ ОТГРУЗКА ИЗ ЗАКАЗА ===
app.post('/api/sales/orders/:id/ship', async (req, res) => {
    const orderId = req.params.id;
    const { items_to_ship, driver, auto, poa_info, user_id } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const docNum = `PH-${new Date().getTime().toString().slice(-6)}`;
        let desc = `Частичная отгрузка по Заказу №${docNum}`;
        if (driver || auto) desc += ` | Транспорт: ${auto || '-'} (Водитель: ${driver || '-'})`;
        if (poa_info) desc += ` | ${poa_info}`;

        let allCompleted = true;

        const resWh = await client.query(`SELECT id FROM warehouses WHERE type = 'reserve' LIMIT 1`);
        const reserveWhId = resWh.rows.length > 0 ? resWh.rows[0].id : 7;

        for (let item of items_to_ship) {
            if (item.qty <= 0) continue;

            // Списываем со склада резерва (СВЯЗЫВАЕМ СО СТРОКОЙ ЗАКАЗА - linked_order_item_id)
            await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id, linked_order_item_id) 
                VALUES ($1, $2, 'sales_shipment', $3, $4, $5, $6)
            `, [item.item_id, -item.qty, desc, reserveWhId, user_id || null, item.coi_id]);

            // Плюсуем количество отгруженного в самом заказе
            await client.query(`
                UPDATE client_order_items SET qty_shipped = COALESCE(qty_shipped, 0) + $1 WHERE id = $2
            `, [item.qty, item.coi_id]);
        }

        const checkRes = await client.query(`SELECT qty_ordered, COALESCE(qty_shipped, 0) as qty_shipped FROM client_order_items WHERE order_id = $1`, [orderId]);
        for (let row of checkRes.rows) {
            if (parseFloat(row.qty_shipped) < parseFloat(row.qty_ordered)) {
                allCompleted = false; break;
            }
        }

        if (allCompleted) await client.query(`UPDATE client_orders SET status = 'completed' WHERE id = $1`, [orderId]);

        await client.query('COMMIT');
        res.json({ success: true, docNum, isCompleted: allCompleted });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).send(err.message); } finally { client.release(); }
});

// === УДАЛЕНИЕ ОТГРУЗКИ (НАКЛАДНОЙ) И ОТКАТ ПРОГРЕССА ЗАКАЗА ===
app.delete('/api/sales/shipment/:docNum', async (req, res) => {
    const docNum = req.params.docNum;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Откат прогресса в Заказе (если это была частичная отгрузка)
        const movs = await client.query(`SELECT linked_order_item_id, quantity FROM inventory_movements WHERE description LIKE $1 AND linked_order_item_id IS NOT NULL`, [`%${docNum}%`]);
        for (let m of movs.rows) {
            await client.query(`UPDATE client_order_items SET qty_shipped = GREATEST(COALESCE(qty_shipped, 0) - ABS($1), 0) WHERE id = $2`, [m.quantity, m.linked_order_item_id]);
            await client.query(`UPDATE client_orders SET status = 'pending' WHERE id = (SELECT order_id FROM client_order_items WHERE id = $1)`, [m.linked_order_item_id]);
        }

        // 2. Откат финансов
        const txs = await client.query(`SELECT id, amount, account_id, transaction_type FROM transactions WHERE description LIKE $1`, [`%${docNum}%`]);
        for (let tx of txs.rows) {
            if (tx.transaction_type === 'income') await client.query(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [tx.amount, tx.account_id]);
            else await client.query(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [tx.amount, tx.account_id]);
            await client.query(`DELETE FROM transactions WHERE id = $1`, [tx.id]);
        }
        await client.query(`DELETE FROM invoices WHERE invoice_number = $1`, [docNum]);

        // 3. Возврат товара на склад (Удаление движений)
        await client.query(`DELETE FROM inventory_movements WHERE description LIKE $1`, [`%${docNum}%`]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).send(err.message); } finally { client.release(); }
});

// === УДАЛЕНИЕ ЗАКАЗА ЦЕЛИКОМ ===
app.delete('/api/sales/orders/:id', async (req, res) => {
    const orderId = req.params.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const orderRes = await client.query(`SELECT doc_number FROM client_orders WHERE id = $1`, [orderId]);
        if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
        const docNum = orderRes.rows[0].doc_number;

        // 1. Удаляем задачи из плана производства
        await client.query(`DELETE FROM planned_production WHERE order_item_id IN (SELECT id FROM client_order_items WHERE order_id = $1)`, [orderId]);

        // 2. Возвращаем плитку из Резерва обратно на свободные склады
        await client.query(`DELETE FROM inventory_movements WHERE description LIKE $1`, [`%${docNum}%`]);

        // 3. Откатываем авансы (если были)
        const txs = await client.query(`SELECT id, amount, account_id, transaction_type FROM transactions WHERE description LIKE $1`, [`%${docNum}%`]);
        for (let tx of txs.rows) {
            if (tx.transaction_type === 'income') await client.query(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [tx.amount, tx.account_id]);
            else await client.query(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [tx.amount, tx.account_id]);
            await client.query(`DELETE FROM transactions WHERE id = $1`, [tx.id]);
        }
        await client.query(`DELETE FROM invoices WHERE invoice_number = $1`, [docNum]);

        // 4. Удаляем сам заказ (строки удалятся каскадно)
        await client.query(`DELETE FROM client_orders WHERE id = $1`, [orderId]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).send(err.message); } finally { client.release(); }
});

// === ВОЗВРАТЫ ОТ КЛИЕНТОВ (Товар и Поддоны) ===
app.post('/api/sales/returns', async (req, res) => {
    const { counterparty_id, items, pallets_returned, refund_method, refund_amount, account_id, reason, user_id } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const docNum = `ВЗ-${new Date().getTime().toString().slice(-6)}`;
        let desc = `Возврат от покупателя №${docNum}`;
        if (reason) desc += ` | Причина: ${reason}`;

        // 1. Создаем документ возврата
        const retRes = await client.query(`
            INSERT INTO customer_returns (doc_number, counterparty_id, total_amount, reason, user_id) 
            VALUES ($1, $2, $3, $4, $5) RETURNING id
        `, [docNum, counterparty_id, refund_amount || 0, reason, user_id || null]);
        const returnId = retRes.rows[0].id;

        // 2. Списываем долг по поддонам (не даем уйти в минус ниже нуля)
        if (pallets_returned && parseInt(pallets_returned) > 0) {
            await client.query(`UPDATE counterparties SET pallets_balance = GREATEST(pallets_balance - $1, 0) WHERE id = $2`, [parseInt(pallets_returned), counterparty_id]);
            desc += ` | Возврат поддонов: ${pallets_returned} шт.`;
        }

        // 3. Возвращаем товар на склады
        if (items && items.length > 0) {
            for (let item of items) {
                const whId = item.warehouse_id || 4;

                // Возврат на указанный склад (Годная или Уценка)
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, user_id) 
                    VALUES ($1, $2, 'customer_return', $3, $4, $5)
                `, [item.id, item.qty, desc, whId, user_id || null]);

                // Детализация возврата
                await client.query(`
                    INSERT INTO customer_return_items (return_id, item_id, quantity, price, warehouse_id) 
                    VALUES ($1, $2, $3, $4, $5)
                `, [returnId, item.id, item.qty, item.price, whId]);
            }
        }

        // 4. Финансы (Возврат денег из кассы или списание долга)
        if (parseFloat(refund_amount) > 0) {
            if (refund_method === 'cash' && account_id) {
                const vatAmount = (refund_amount * 22) / 122;
                await client.query(`
                    INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, user_id) 
                    VALUES ($1, 'expense', 'Возврат средств покупателю', $2, $3, 'Сразу', $4, $5, $6)
                `, [refund_amount, desc, vatAmount, account_id, counterparty_id, user_id || null]);
                await client.query(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [refund_amount, account_id]);
            } else if (refund_method === 'debt') {
                // Создаем отрицательный счет (списываем долг по акту сверки)
                await client.query(`
                    INSERT INTO invoices (counterparty_id, invoice_number, amount, description, status, user_id) 
                    VALUES ($1, $2, $3, $4, 'paid', $5)
                `, [counterparty_id, docNum, -Math.abs(refund_amount), desc, user_id || null]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, docNum });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// ==============================================================================
// БЛОК: СИНХРОНИЗАЦИЯ БАЛАНСОВ ПРИ СТАРТЕ СЕРВЕРА (Самолечение)
// ==============================================================================
pool.query(`
    BEGIN;
    
    -- 0. АВТО-ЛЕЧЕНИЕ БАЗЫ: Создаем таблицу счетов (invoices), если её нет!
    CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        counterparty_id INTEGER REFERENCES counterparties(id),
        invoice_number VARCHAR(50) NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 1. Создаем базовые счета, если их вдруг удалили
    INSERT INTO accounts (name, type, balance, is_default) SELECT 'Наличные (Касса)', 'cash', 0, true WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE name = 'Наличные (Касса)');
    INSERT INTO accounts (name, type, balance, is_default) SELECT 'Альфа Банк', 'bank', 0, false WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE name = 'Альфа Банк');
    INSERT INTO accounts (name, type, balance, is_default) SELECT 'Точка Банк', 'bank', 0, false WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE name = 'Точка Банк');

    -- 2. Привязываем "сиротские" транзакции к кассе
    UPDATE transactions SET account_id = (SELECT id FROM accounts WHERE name = 'Наличные (Касса)' LIMIT 1) WHERE account_id IS NULL;
    UPDATE salary_payments SET account_id = (SELECT id FROM accounts WHERE name = 'Наличные (Касса)' LIMIT 1) WHERE account_id IS NULL;

    -- 3. Жесткий пересчет реальных остатков по всей истории операций
    UPDATE accounts SET balance = COALESCE(
        (SELECT SUM(amount) FROM transactions WHERE account_id = accounts.id AND transaction_type = 'income'), 0
    ) - COALESCE(
        (SELECT SUM(amount) FROM transactions WHERE account_id = accounts.id AND transaction_type = 'expense'), 0
    ) - COALESCE(
        (SELECT SUM(amount) FROM salary_payments WHERE account_id = accounts.id AND linked_transaction_id IS NULL), 0
    );

    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_url VARCHAR(500);

    COMMIT;
`).then(() => console.log('✅ База данных Плиттекс успешно синхронизирована (включая счета)!'))
    .catch(err => console.error('❌ Ошибка синхронизации БД:', err.message));

// === АКТИВНЫЕ ЗАКАЗЫ (ОЖИДАЮТ ОТГРУЗКИ / ПРОИЗВОДСТВА) ===
app.get('/api/sales/orders', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.id, o.doc_number, o.total_amount, o.status, o.counterparty_id, 
                   o.delivery_address, TO_CHAR(o.planned_shipment_date, 'DD.MM.YYYY') as deadline,
                   TO_CHAR(o.created_at, 'DD.MM.YYYY HH24:MI') as date_formatted,
                   c.name as client_name,
                   (SELECT string_agg(i.name || ' (' || coi.qty_ordered || ' ед)', ', ') 
                    FROM client_order_items coi JOIN items i ON coi.item_id = i.id WHERE coi.order_id = o.id) as items_list,
                   (SELECT SUM(qty_ordered) FROM client_order_items WHERE order_id = o.id) as total_ordered,
                   (SELECT SUM(COALESCE(qty_shipped, 0)) FROM client_order_items WHERE order_id = o.id) as total_shipped
            FROM client_orders o
            LEFT JOIN counterparties c ON o.counterparty_id = c.id
            WHERE o.status != 'completed'
            ORDER BY o.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.listen(port, () => {
    console.log(`🚀 ERP Плиттекс Server запущен: http://localhost:${port}`);
});