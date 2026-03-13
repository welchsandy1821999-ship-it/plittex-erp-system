const express = require('express');
const router = express.Router();
const Big = require('big.js');

// Функция перевода суммы прописью (встроена локально для счетов)
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

    const rubles = Math.floor(num); const kopecks = Math.round((num - rubles) * 100);
    let words = '';
    if (rubles === 0) { words = 'Ноль '; } else {
        let r = rubles; const millions = Math.floor(r / 1000000); r %= 1000000; const thousands = Math.floor(r / 1000); r %= 1000; const unitsPart = r;
        if (millions > 0) words += getWord(millions, 1) + 'миллион' + (millions % 10 === 1 && millions % 100 !== 11 ? '' : (millions % 10 >= 2 && millions % 10 <= 4 && (millions % 100 < 10 || millions % 100 >= 20) ? 'а' : 'ов')) + ' ';
        if (thousands > 0) words += getWord(thousands, 0) + 'тысяч' + (thousands % 10 === 1 && thousands % 100 !== 11 ? 'а' : (thousands % 10 >= 2 && thousands % 10 <= 4 && (thousands % 100 < 10 || thousands % 100 >= 20) ? 'и' : '')) + ' ';
        if (unitsPart > 0) words += getWord(unitsPart, 1);
    }
    words += 'рубл' + (rubles % 10 === 1 && rubles % 100 !== 11 ? 'ь' : (rubles % 10 >= 2 && rubles % 10 <= 4 && (rubles % 100 < 10 || rubles % 100 >= 20) ? 'я' : 'ей'));
    return words.charAt(0).toUpperCase() + words.slice(1).trim() + ' ' + String(kopecks).padStart(2, '0') + ' копеек';
}

module.exports = function (pool, getNextDocNumber) {

    // ВАЖНО: Маршрут использует express.urlencoded локально
    router.post('/print/kp', express.urlencoded({ extended: true }), async (req, res) => {
        try {
            const data = JSON.parse(req.body.data);
            const cpRes = await pool.query('SELECT name, phone, inn, legal_address as address, director_name FROM counterparties WHERE id = $1', [data.client_id]);
            const client = cpRes.rows[0] || { name: 'Неизвестный клиент', phone: '', inn: '', address: '', director_name: '' };

            res.render('docs/blank_order', {
                order: { doc_number: 'ЧЕРНОВИК', date_formatted: new Date().toLocaleDateString('ru-RU'), client_name: client.name, legal_address: client.address, phone: client.phone, inn: client.inn, director_name: client.director_name },
                items: data.items, discount: parseFloat(data.discount) || 0, logistics: parseFloat(data.logistics) || 0
            });
        } catch (err) { res.status(500).send('Ошибка Бланка: ' + err.message); }
    });

    router.get('/print/blank-order', async (req, res) => {
        try {
            const bRes = await pool.query(`SELECT b.*, c.name as client_name, c.phone, c.inn, c.legal_address, c.director_name, TO_CHAR(b.created_at, 'DD.MM.YYYY') as date_formatted FROM blank_orders b LEFT JOIN counterparties c ON b.counterparty_id = c.id WHERE b.id = $1`, [req.query.id]);
            if (bRes.rows.length === 0) return res.status(404).send('Не найден');
            const orderInfo = bRes.rows[0];
            res.render('docs/blank_order', { order: orderInfo, items: [{ name: orderInfo.item_name, qty: orderInfo.quantity, price: orderInfo.price, unit: 'шт' }] });
        } catch (err) { res.status(500).send(err.message); }
    });

    router.get('/print/invoice', async (req, res) => {
        const { docNum, cp_id, amount, custom_amount, desc, bank } = req.query;
        try {
            const today = new Date(); const deadline = new Date(today); deadline.setDate(deadline.getDate() + 5);
            let finalData = {
                payUntil: deadline.toLocaleDateString('ru-RU'),
                dateLong: `${today.getDate()} ${['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][today.getMonth()]} ${today.getFullYear()} г.`,
                myCompany: { name: 'ООО "ПЛИТТЕКС"', inn: '2372029123', kpp: '237201001', address: '352244, Краснодарский край, г. Новокубанск, ул. Кузнечная, д. 1 оф.2' },
                myBank: bank === 'alfa' ? { name: 'АО «Альфа-Банк», г. Москва', account: '40817810405610835875', bik: '044525593', corr: '30101810200000000593' } : { name: 'ООО "Банк Точка" г. Москва', account: '40702810901500100003', bik: '044525104', corr: '30101810745374525104' },
                invoiceNum: '', docNum: '', amount: 0, baseAmount: 0, vatAmount: 0, amountWords: '', totalOrderSum: 0, cp: {}, items: []
            };

            if (docNum) {
                const orderRes = await pool.query(`SELECT * FROM client_orders WHERE doc_number = $1`, [docNum]);
                if (orderRes.rows.length === 0) return res.status(404).send('Заказ не найден');
                const cpRes = await pool.query('SELECT id, name, inn, kpp, legal_address FROM counterparties WHERE id = $1', [orderRes.rows[0].counterparty_id]);
                finalData.cp = cpRes.rows[0] || { name: 'Неизвестный' };
                const itemsRes = await pool.query(`SELECT i.name, i.unit, coi.qty_ordered as qty, coi.price FROM client_order_items coi JOIN items i ON coi.item_id = i.id WHERE coi.order_id = $1`, [orderRes.rows[0].id]);
                finalData.items = itemsRes.rows;
                const invRes = await pool.query(`SELECT SUM(amount) as debt FROM invoices WHERE invoice_number = $1 AND status = 'pending'`, [docNum]);
                finalData.totalOrderSum = parseFloat(orderRes.rows[0].total_amount);
                finalData.amount = custom_amount ? parseFloat(custom_amount) : (invRes.rows[0].debt ? parseFloat(invRes.rows[0].debt) : finalData.totalOrderSum);
                finalData.invoiceNum = docNum; finalData.docNum = docNum;
            } else if (cp_id && amount) {
                const cpRes = await pool.query('SELECT name, inn, kpp, legal_address FROM counterparties WHERE id = $1', [cp_id]);
                if (cpRes.rows.length === 0) return res.status(404).send('Не найден');
                finalData.cp = cpRes.rows[0];
                finalData.amount = parseFloat(amount); finalData.totalOrderSum = finalData.amount;
                finalData.invoiceNum = await getNextDocNumber(pool, 'СЧ', 'invoices', 'invoice_number');
                finalData.docNum = 'Б/Н (Пополнение баланса)';
                finalData.items = [{ name: desc || 'Оплата (Аванс)', unit: 'шт', qty: 1, price: finalData.amount }];
            }

            const amountBig = new Big(finalData.amount);
            finalData.vatAmount = Number(amountBig.times(22).div(122).round(2));
            finalData.baseAmount = Number(amountBig.minus(finalData.vatAmount).round(2));
            finalData.amountWords = numberToWordsRu(finalData.amount);

            if (finalData.amount > 0) {
                const checkInv = await pool.query(`SELECT id FROM invoices WHERE invoice_number = $1`, [finalData.invoiceNum]);
                if (checkInv.rows.length === 0 && (finalData.cp.id || cp_id)) {
                    await pool.query(`INSERT INTO invoices (invoice_number, counterparty_id, amount, description, status) VALUES ($1, $2, $3, $4, 'pending')`, [finalData.invoiceNum, finalData.cp.id || cp_id, finalData.amount, docNum ? `Оплата по заказу ${docNum}` : (desc || 'Аванс')]);
                }
            }
            // === ГЕНЕРАЦИЯ ГОСТ QR-КОДА ДЛЯ ОПЛАТЫ ЧЕРЕЗ БАНК ===
            const sumInKopecks = Math.round(finalData.amount * 100); // Сумма в копейках
            const purpose = docNum ? `Оплата по заказу ${docNum}` : (desc || 'Аванс');
            // Строка по стандарту Сбербанка/ГОСТ
            const gostStr = `ST00012|Name=${finalData.myCompany.name}|PersonalAcc=${finalData.myBank.account}|BankName=${finalData.myBank.name}|BIC=${finalData.myBank.bik}|CorrespAcc=${finalData.myBank.corr}|PayeeINN=${finalData.myCompany.inn}|KPP=${finalData.myCompany.kpp}|Purpose=${purpose}|Sum=${sumInKopecks}`;

            // Используем бесплатный API для генерации картинки QR-кода
            finalData.qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(gostStr)}`;
            res.render('docs/invoice', finalData);
        } catch (err) { res.status(500).send(err.message); }
    });

    router.get('/print/waybill', async (req, res) => {
        try {
            let clientName = 'Неизвестный клиент'; let totalAmount = 0; let transportInfo = ''; let discountInfo = ''; let contractInfo = 'Основной договор';
            const { docNum } = req.query;
            const txRes = await pool.query(`SELECT t.amount, c.name FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id WHERE t.description LIKE $1`, [`%${docNum}%`]);
            if (txRes.rows.length > 0) { totalAmount = txRes.rows[0].amount; clientName = txRes.rows[0].name; }
            else {
                const invRes = await pool.query(`SELECT i.amount, c.name FROM invoices i LEFT JOIN counterparties c ON i.counterparty_id = c.id WHERE i.invoice_number = $1`, [docNum]);
                if (invRes.rows.length > 0) { totalAmount = invRes.rows[0].amount; clientName = invRes.rows[0].name; }
            }
            const descRes = await pool.query(`SELECT description FROM inventory_movements WHERE movement_type = 'sales_shipment' AND description LIKE $1 LIMIT 1`, [`%${docNum}%`]);
            if (descRes.rows.length > 0) {
                const d = descRes.rows[0].description;
                const tm = d.match(/Транспорт:\s([^|]+)/); if (tm) transportInfo = tm[1].trim();
                const dm = d.match(/Скидка:\s([^|]+)/); if (dm) discountInfo = dm[1].trim();
                const cm = d.match(/Основание:\s([^|]+)/); if (cm) contractInfo = cm[1].trim();
            }
            const itemsRes = await pool.query(`SELECT i.name, i.unit, SUM(ABS(m.quantity)) as qty FROM inventory_movements m JOIN items i ON m.item_id = i.id WHERE m.movement_type = 'sales_shipment' AND m.description LIKE $1 GROUP BY i.name, i.unit`, [`%${docNum}%`]);
            res.render('docs/waybill', { docNum, clientName, totalAmount, transportInfo, discountInfo, contractInfo, items: itemsRes.rows, date: new Date().toLocaleDateString('ru-RU') });
        } catch (err) { res.status(500).send(err.message); }
    });

    router.get('/print/upd', async (req, res) => {
        try {
            const { docNum } = req.query;
            let clientName = 'Неизвестный клиент'; let totalAmount = 0; let transportInfo = 'Самовывоз'; let cpInfo = {}; let palletsQty = 0;
            const orderRes = await pool.query(`SELECT c.name, c.inn, c.kpp, c.legal_address FROM inventory_movements m JOIN client_order_items coi ON m.linked_order_item_id = coi.id JOIN client_orders o ON coi.order_id = o.id JOIN counterparties c ON o.counterparty_id = c.id WHERE m.movement_type = 'sales_shipment' AND m.description LIKE $1 LIMIT 1`, [`%${docNum}%`]);
            if (orderRes.rows.length > 0) { clientName = orderRes.rows[0].name; cpInfo = orderRes.rows[0]; }
            const descRes = await pool.query(`SELECT description FROM inventory_movements WHERE movement_type = 'sales_shipment' AND description LIKE $1 LIMIT 1`, [`%${docNum}%`]);
            if (descRes.rows.length > 0) {
                const tm = descRes.rows[0].description.match(/Транспорт:\s([^|]+)/); if (tm) transportInfo = tm[1].trim();
                const pm = descRes.rows[0].description.match(/Поддоны:\s*(\d+)/); if (pm) palletsQty = parseInt(pm[1]);
            }
            const itemsRes = await pool.query(`SELECT i.name, i.unit, SUM(ABS(m.quantity)) as qty, coi.price FROM inventory_movements m JOIN items i ON m.item_id = i.id LEFT JOIN client_order_items coi ON m.linked_order_item_id = coi.id WHERE m.movement_type = 'sales_shipment' AND m.description LIKE $1 GROUP BY i.name, i.unit, coi.price`, [`%${docNum}%`]);
            let items = itemsRes.rows.map(row => { row.cost = parseFloat(row.qty) * parseFloat(row.price || 0); totalAmount += row.cost; return row; });
            if (palletsQty > 0) items.push({ name: 'Поддон деревянный (возвратная тара)', unit: 'шт', qty: palletsQty, price: 0, cost: 0 });
            res.render('docs/upd', { docNum, clientName, cpInfo, totalAmount, transportInfo, palletsQty, items, date: new Date().toLocaleDateString('ru-RU'), time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) });
        } catch (err) { res.status(500).send(err.message); }
    });

    router.get('/print/contract', async (req, res) => {
        try {
            const result = await pool.query(`SELECT c.number, TO_CHAR(c.date, 'DD.MM.YYYY') as date_formatted, cp.* FROM contracts c JOIN counterparties cp ON c.counterparty_id = cp.id WHERE c.id = $1`, [req.query.id]);
            if (result.rows.length === 0) return res.status(404).send('Не найден');
            const myCompany = { name: 'ООО "ПЛИТТЕКС"', director: 'Иванов И.И.', inn: '2372029123', kpp: '237201001', address: '352244, Краснодарский край, г. Новокубанск, ул. Кузнечная, д. 1 оф.2', bank: 'ООО "Банк Точка" г. Москва', account: '40702810901500100003', bik: '044525104', corr: '30101810745374525104' };
            res.render('docs/contract', { contract: result.rows[0], myCompany });
        } catch (err) { res.status(500).send(err.message); }
    });

    router.get('/print/specification', async (req, res) => {
        try {
            const { docNum } = req.query; let clientName = 'Неизвестный клиент'; let totalAmount = 0; let contractInfo = 'Основной договор';
            const txRes = await pool.query(`SELECT t.amount, c.name FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id WHERE t.description LIKE $1`, [`%${docNum}%`]);
            if (txRes.rows.length > 0) { totalAmount = txRes.rows[0].amount; clientName = txRes.rows[0].name; }
            else {
                const invRes = await pool.query(`SELECT i.amount, c.name FROM invoices i LEFT JOIN counterparties c ON i.counterparty_id = c.id WHERE i.invoice_number = $1`, [docNum]);
                if (invRes.rows.length > 0) { totalAmount = invRes.rows[0].amount; clientName = invRes.rows[0].name; }
            }
            const descRes = await pool.query(`SELECT description FROM inventory_movements WHERE movement_type = 'sales_shipment' AND description LIKE $1 LIMIT 1`, [`%${docNum}%`]);
            if (descRes.rows.length > 0) { const cm = descRes.rows[0].description.match(/Основание:\s([^|]+)/); if (cm) contractInfo = cm[1].trim(); }
            const itemsRes = await pool.query(`SELECT i.name, i.unit, i.current_price as price, SUM(ABS(m.quantity)) as qty FROM inventory_movements m JOIN items i ON m.item_id = i.id WHERE m.movement_type = 'sales_shipment' AND m.description LIKE $1 GROUP BY i.name, i.unit, i.current_price`, [`%${docNum}%`]);
            res.render('docs/specification', { docNum, clientName, totalAmount, contractInfo, items: itemsRes.rows, date: new Date().toLocaleDateString('ru-RU') });
        } catch (err) { res.status(500).send(err.message); }
    });

    return router;
};