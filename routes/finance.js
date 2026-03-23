const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Big = require('big.js');

// 🚀 Единая функция поиска документов в тексте (Защита от опечаток)
function extractDocNumber(description) {
    if (!description) return null;
    const match = String(description).match(/(СЧ|ЗК)-(\d+)/i);
    return match ? match[0].toUpperCase() : null;
}

module.exports = function (pool, upload, withTransaction, ERP_CONFIG) {

    // ==========================================
    // 1. ОТЧЕТ P&L (ДИНАМИЧЕСКИЙ МЕТОД СО СРЕДНЕВЗВЕШЕННОЙ COGS И ТАБЕЛЯМИ)
    // ==========================================
    router.get('/api/finance/pnl', async (req, res) => {
        let { start, end } = req.query;

        if (!start || !end || start === '' || end === '') {
            start = '2024-01-01';
            end = new Date().toISOString().split('T')[0];
        }

        try {
            // Запускаем все тяжелые расчеты параллельно для максимальной скорости!
            const [revenueRes, cogsRes, laborRes, otherIncomeRes, indirectCostsRes] = await Promise.all([
                // 💰 1. ВЫРУЧКА (Отгруженные заказы)
                pool.query(`
                    SELECT COALESCE(SUM(total_amount), 0) as total 
                    FROM client_orders 
                    WHERE status = 'completed' AND created_at::date >= $1 AND created_at::date <= $2
                `, [start, end]),

                // 🧱 2. СЕБЕСТОИМОСТЬ ПРОДАЖ (COGS: Средневзвешенная стоимость отгруженных материалов)
                // За основу берем только те партии, где actual_good_qty > 0, чтобы избежать деления на ноль
                pool.query(`
                    WITH ItemCosts AS (
                        SELECT product_id, 
                               SUM(mat_cost_total) / NULLIF(SUM(actual_good_qty), 0) as avg_unit_mat_cost
                        FROM production_batches
                        WHERE status = 'completed' AND actual_good_qty > 0
                        GROUP BY product_id
                    )
                    SELECT COALESCE(SUM(coi.qty_shipped * ic.avg_unit_mat_cost), 0) as total
                    FROM client_order_items coi
                    JOIN client_orders co ON coi.order_id = co.id
                    JOIN ItemCosts ic ON coi.item_id = ic.product_id
                    WHERE co.status = 'completed'
                      AND coi.qty_shipped > 0
                      AND co.created_at::date >= $1 AND co.created_at::date <= $2
                `, [start, end]),

                // 👷‍♂️ 3. ФАКТИЧЕСКИЕ ЗАРПЛАТЫ (Оклады + Сделка из табеля)
                pool.query(`
                    SELECT COALESCE(SUM(bonus + custom_rate), 0) as total
                    FROM timesheet_records
                    WHERE record_date >= $1 AND record_date <= $2
                      AND status = 'present'
                `, [start, end]),

                // 📈 4. ПОБОЧНЫЕ ДОХОДЫ (Транзакции минус выручка и займы)
                pool.query(`
                    SELECT COALESCE(SUM(amount), 0) as total
                    FROM transactions 
                    WHERE transaction_type = 'income' 
                      AND COALESCE(is_deleted, false) = false
                      AND category NOT IN ('Продажа продукции', 'Ввод остатков', 'Техническая проводка', 'Получение займов')
                      AND transaction_date::date >= $1 AND transaction_date::date <= $2
                `, [start, end]),

                // 📉 5. КОСВЕННЫЕ РАСХОДЫ (Транзакции минус сырье и зарплаты)
                pool.query(`
                    SELECT COALESCE(SUM(amount), 0) as total
                    FROM transactions 
                    WHERE transaction_type = 'expense' 
                      AND COALESCE(is_deleted, false) = false
                      AND category NOT IN ('Закупка сырья', 'Зарплата', 'Зарплата и Авансы', 'Возврат займов', 'Перевод', 'Техническая проводка')
                      AND transaction_date::date >= $1 AND transaction_date::date <= $2
                `, [start, end])
            ]);

            // 🧮 МАТЕМАТИКА P&L (Библиотека Big.js для точности до копеек)
            const revenue = new Big(Number(revenueRes.rows[0].total));
            const otherIncome = new Big(Number(otherIncomeRes.rows[0].total));
            
            const cogs = new Big(Number(cogsRes.rows[0].total));
            const labor = new Big(Number(laborRes.rows[0].total));
            const indirect = new Big(Number(indirectCostsRes.rows[0].total));

            // Общие доходы и расходы
            const totalIncome = revenue.plus(otherIncome);
            const totalExpenses = cogs.plus(labor).plus(indirect);

            // Чистая прибыль
            const netProfit = totalIncome.minus(totalExpenses);
            
            // Рентабельность рассчитываем от общих доходов, если они больше нуля
            const margin = totalIncome.gt(0) ? netProfit.div(totalIncome).times(100).toFixed(1) : "0.0";

            // Отправляем JSON-структуру на фронт
            res.json({
                revenue: revenue.toFixed(2),
                otherIncome: otherIncome.toFixed(2),
                totalIncome: totalIncome.toFixed(2),
                
                cogs: cogs.toFixed(2),
                laborCosts: labor.toFixed(2),
                indirectCosts: indirect.toFixed(2),
                totalExpenses: totalExpenses.toFixed(2),
                
                netProfit: netProfit.toFixed(2),
                margin: margin
            });

        } catch (err) {
            console.error('КРИТИЧЕСКАЯ ОШИБКА P&L:', err.message, err.stack);
            res.status(500).json({ error: "Ошибка расчета P&L: " + err.message });
        }
    });

    // ==========================================
    // 2. ПЛАТЕЖНЫЙ КАЛЕНДАРЬ (ПЛАНОВЫЕ РАСХОДЫ)
    // ==========================================
    router.get('/api/finance/planned-expenses', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT id, TO_CHAR(date, 'DD.MM.YYYY') as date, category, description, amount, is_recurring 
                FROM planned_expenses WHERE status = 'pending' ORDER BY date ASC
            `);
            res.json(result.rows);
        } catch (err) {
            console.error('Ошибка загрузки календаря:', err.message);
            res.json([]);
        }
    });

    router.post('/api/finance/planned-expenses/:id/pay', async (req, res) => {
        const { account_id } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                const expRes = await client.query("UPDATE planned_expenses SET status = 'paid' WHERE id = $1 RETURNING *", [req.params.id]);
                if (expRes.rows.length === 0) throw new Error('Платеж не найден');
                const exp = expRes.rows[0];

                if (parseFloat(exp.amount) <= 0) throw new Error('Сумма платежа должна быть больше нуля');

                const desc = `Оплата плана: ${exp.category} (${exp.description || ''})`;

                await client.query(`
                    INSERT INTO transactions (account_id, amount, transaction_type, category, description, transaction_date, payment_method, source_module)
                    VALUES ($1, $2, 'expense', $3, $4, NOW(), $5, $6)
                `, [account_id, exp.amount, exp.category, desc, 'Безналичный расчет', 'finance']);

                if (exp.is_recurring) {
                    const nextDate = new Date(exp.date);
                    nextDate.setMonth(nextDate.getMonth() + 1);
                    await client.query(
                        'INSERT INTO planned_expenses (date, amount, category, description, is_recurring, status) VALUES ($1, $2, $3, $4, $5, $6)',
                        [nextDate, exp.amount, exp.category, exp.description, true, 'pending']
                    );
                }
            });
            res.json({ success: true, message: 'Платеж успешно проведен' });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==========================================
    // 3. ТРАНЗАКЦИИ: СПИСОК И МАССОВОЕ УДАЛЕНИЕ
    // ==========================================
    router.get('/api/transactions', async (req, res) => {
        // 1. ДОБАВИЛИ type СЮДА 👇
        const { search, start, end, account_id, page, limit, type } = req.query;

        const parsedPage = parseInt(page) || 1;
        const parsedLimit = parseInt(limit) || 20;
        const offset = Math.max((parsedPage - 1) * parsedLimit, 0);

        try {
            let conditions = [
                "COALESCE(t.is_deleted, false) = false",
                "t.category NOT IN ('Корректировка долга', 'Перевод', 'Ввод остатков')"
            ];
            let params = [];
            let paramIndex = 1;

            if (account_id && account_id !== 'null' && account_id !== 'undefined') {
                conditions.push(`t.account_id = $${paramIndex}`);
                params.push(parseInt(account_id));
                paramIndex++;
            }

            // 2. ДОБАВИЛИ ФИЛЬТР ПО ТИПУ (ДОХОД/РАСХОД) СЮДА 👇
            if (type && type !== 'all') {
                conditions.push(`t.transaction_type = $${paramIndex}`);
                params.push(type);
                paramIndex++;
            }

            if (search && String(search).trim() !== '') {
                conditions.push(`(t.description ILIKE $${paramIndex} OR t.category ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex})`);
                params.push(`%${String(search).trim()}%`);
                paramIndex++;
            }

            if (start && end) {
                conditions.push(`t.transaction_date >= $${paramIndex}::timestamp AND t.transaction_date <= $${paramIndex + 1}::timestamp + interval '1 day' - interval '1 second'`);
                params.push(start, end);
                paramIndex += 2;
            }

            const whereClause = `WHERE ${conditions.join(' AND ')}`;

            const countRes = await pool.query(`SELECT COUNT(*) FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id ${whereClause}`, params);
            const totalRecords = parseInt(countRes.rows[0].count);

            const dataQuery = `
                SELECT t.id, t.transaction_date, t.amount, t.transaction_type, 
                       t.category, t.description, t.payment_method, t.vat_amount,
                       t.counterparty_id, t.account_id, /* 👈 ДОБАВИЛИ t.account_id СЮДА */
                       c.name as counterparty_name, a.name as account_name
                FROM transactions t
                LEFT JOIN counterparties c ON t.counterparty_id = c.id
                LEFT JOIN accounts a ON t.account_id = a.id
                ${whereClause} 
                ORDER BY t.transaction_date DESC, t.id DESC 
                LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
            `;
            const dataParams = [...params, parsedLimit, offset];
            const dataRes = await pool.query(dataQuery, dataParams);

            res.json({
                data: dataRes.rows,
                pagination: {
                    total: totalRecords,
                    page: parsedPage,
                    limit: parsedLimit,
                    totalPages: Math.ceil(totalRecords / parsedLimit) || 1
                }
            });
        } catch (err) {
            console.error('Ошибка загрузки транзакций:', err);
            res.status(500).json({ error: 'Ошибка сервера при загрузке данных' });
        }
    });

    router.post('/api/transactions/bulk-delete', async (req, res) => {
        const { ids } = req.body;
        if (!ids || ids.length === 0) return res.json({ success: true });

        try {
            await withTransaction(pool, async (client) => {
                for (let id of ids) {
                    const txRes = await client.query('SELECT amount, transaction_type, account_id, description FROM transactions WHERE id = $1', [id]);
                    if (txRes.rows.length > 0) {
                        const { description } = txRes.rows[0];
                        const docNum = extractDocNumber(description);
                        if (docNum) {
                            await client.query(`UPDATE invoices SET status = 'pending' WHERE invoice_number = $1`, [docNum]);
                        }
                        await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [id]);
                    }
                }
            });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ==========================================
    // 4. КАТЕГОРИИ ТРАНЗАКЦИЙ (СПРАВОЧНИК)
    // ==========================================
    router.get('/api/finance/categories', async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM transaction_categories ORDER BY type, name');
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/finance/categories', async (req, res) => {
        try {
            await pool.query('INSERT INTO transaction_categories (name, type) VALUES ($1, $2)', [req.body.name, req.body.type]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete('/api/finance/categories/:id', async (req, res) => {
        try {
            await pool.query('DELETE FROM transaction_categories WHERE id = $1', [req.params.id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ==========================================
    // 5. КОНТРАГЕНТЫ (CRM) И КАРТОЧКА 360°
    // ==========================================
    router.get('/api/counterparties', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT c.*, 
                       COALESCE(SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END), 0) as total_paid_to_us,
                       COALESCE(SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END), 0) as total_paid_by_us,
                       MAX(t.transaction_date) as last_transaction_date
                FROM counterparties c
                LEFT JOIN transactions t ON c.id = t.counterparty_id AND COALESCE(t.is_deleted, false) = false
                GROUP BY c.id
                ORDER BY last_transaction_date DESC NULLS LAST, c.name ASC
            `);
            res.json(result.rows);
        } catch (err) {
            console.error('Ошибка в списке контрагентов:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/api/counterparties/:id/full', async (req, res) => {
        const cpId = req.params.id;
        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
            if (cpRes.rows.length === 0) return res.status(404).json({ error: 'Не найден' });

            const finRes = await pool.query(`
                SELECT 
                    COALESCE(SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END), 0) as total_paid_to_us,
                    COALESCE(SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END), 0) as total_paid_to_them
                FROM transactions 
                WHERE counterparty_id = $1 AND COALESCE(is_deleted, false) = false
            `, [cpId]);

            const finances = finRes.rows[0];
            const balance = parseFloat(finances.total_paid_to_us) - parseFloat(finances.total_paid_to_them);

            res.json({ cp: cpRes.rows[0], finances: { ...finances, balance } });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/counterparties/:id/profile', async (req, res) => {
        const cpId = req.params.id;
        if (!cpId || cpId === 'null') return res.status(400).json({ error: 'ID не указан' });

        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
            if (cpRes.rows.length === 0) return res.status(404).json({ error: 'Контрагент не найден' });
            const cp = cpRes.rows[0];

            // 1. ВСЕ ПЛАТЕЖИ (Транзакции)
            const transRes = await pool.query(`
                SELECT amount, transaction_type, category, description, 
                       TO_CHAR(transaction_date, 'DD.MM.YYYY HH24:MI') as date, 'money' as origin
                FROM transactions WHERE counterparty_id = $1 AND COALESCE(is_deleted, false) = false
            `, [cpId]);

            // 2. НАШИ ОТГРУЗКИ (Продажи клиентам)
            const ordersRes = await pool.query(`
                SELECT total_amount as amount, 'expense' as transaction_type, 'Отгрузка продукции' as category, 
                       'Заказ №' || doc_number as description, TO_CHAR(created_at, 'DD.MM.YYYY') as date, 'goods' as origin
                FROM client_orders WHERE counterparty_id = $1 AND status = 'completed'
            `, [cpId]);

            // 3. ИХ ПОСТАВКИ НАМ (Закупки у поставщиков)
            // Комментарий: Читаем сумму из новой колонки amount в inventory_movements
            const purchaseRes = await pool.query(`
                SELECT amount, 'income' as transaction_type, 'Поставка сырья' as category, 
                       description, TO_CHAR(movement_date, 'DD.MM.YYYY') as date, 'goods' as origin
                FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase'
            `, [cpId]);

            const timeline = [...transRes.rows, ...ordersRes.rows, ...purchaseRes.rows].sort((a, b) => {
                return new Date(b.date.split('.').reverse().join('-')) - new Date(a.date.split('.').reverse().join('-'));
            });

            // УНИВЕРСАЛЬНАЯ ФОРМУЛА САЛЬДО ERP:
            let ourShipments = new Big(0); let ourPayments = new Big(0);
            let theirShipments = new Big(0); let theirPayments = new Big(0);

            ordersRes.rows.forEach(o => ourShipments = ourShipments.plus(o.amount));
            purchaseRes.rows.forEach(p => theirShipments = theirShipments.plus(p.amount));
            transRes.rows.forEach(t => {
                if (t.transaction_type === 'expense') ourPayments = ourPayments.plus(t.amount);
                else theirPayments = theirPayments.plus(t.amount);
            });

            // Положительное сальдо: должны НАМ. Отрицательное: должны МЫ.
            const balance = ourShipments.plus(ourPayments).minus(theirShipments).minus(theirPayments).toFixed(2);

            res.json({
                info: cp,
                transactions: timeline,
                finances: { balance, totalPaid: theirPayments.toFixed(2), totalInvoiced: ourShipments.toFixed(2) },
                invoices: [], contracts: []
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/counterparties/:id/contracts', async (req, res) => {
        const cpId = req.params.id;
        if (!cpId || cpId === 'null' || cpId === 'undefined') return res.json([]);

        try {
            const result = await pool.query(`
                SELECT 
                    c.id as contract_id, c.number as contract_number, TO_CHAR(c.date, 'DD.MM.YYYY') as contract_date,
                    s.id as spec_id, s.number as spec_number, TO_CHAR(s.date, 'DD.MM.YYYY') as spec_date
                FROM contracts c
                LEFT JOIN specifications s ON c.id = s.contract_id
                WHERE c.counterparty_id = $1
                ORDER BY c.date DESC, s.date DESC
            `, [cpId]);
            res.json(result.rows);
        } catch (err) {
            console.error('Ошибка загрузки договоров:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/api/counterparties', async (req, res) => {
        const { name, role, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment } = req.body;
        try {
            await pool.query(`
                INSERT INTO counterparties (name, role, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            `, [name, role || 'Покупатель', client_category || 'Обычный', inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.put('/api/counterparties/:id', async (req, res) => {
        const { name, role, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment } = req.body;
        try {
            await pool.query(`
                UPDATE counterparties SET name=$1, role=$2, client_category=$3, inn=$4, kpp=$5, ogrn=$6, legal_address=$7, fact_address=$8, bank_name=$9, bank_bik=$10, bank_account=$11, bank_corr=$12, director_name=$13, phone=$14, email=$15, comment=$16 
                WHERE id=$17
            `, [name, role, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, req.params.id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/counterparties/:id/correction', async (req, res) => {
        const cpId = req.params.id;
        const { amount, type, date, description } = req.body;
        try {
            await pool.query(`
                INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date) 
                VALUES ($1, $2, 'Корректировка долга', $3, 'Системная правка', NULL, $4, $5)
            `, [amount, type, description, cpId, date]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete('/api/counterparties/:id', async (req, res) => {
        try {
            await withTransaction(pool, async (client) => {
                await client.query('UPDATE transactions SET counterparty_id = NULL WHERE counterparty_id = $1', [req.params.id]);
                await client.query('DELETE FROM counterparties WHERE id = $1', [req.params.id]);
            });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/api/dadata/inn', async (req, res) => {
        const { inn } = req.body;
        const token = "b0dcbe2b0cb2a4deca8c89bcdff453a7cabc4ceb";
        try {
            const response = await fetch("https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": "Token " + token },
                body: JSON.stringify({ query: inn })
            });
            if (!response.ok) return res.status(response.status).json({ error: 'DaData API Error' });
            const data = await response.json();
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: 'Сбой сети на сервере Node.js' });
        }
    });

    router.get('/print/act', async (req, res) => {
        const { cp_id } = req.query;
        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cp_id]);
            if (cpRes.rows.length === 0) return res.status(404).send('Контрагент не найден');
            const transRes = await pool.query(`SELECT amount, transaction_type, category, description, TO_CHAR(created_at, 'DD.MM.YYYY') as date FROM transactions WHERE counterparty_id = $1 ORDER BY created_at ASC`, [cp_id]);
            res.render('docs/act', { cp: cpRes.rows[0], transactions: transRes.rows });
        } catch (err) { res.status(500).send('Ошибка генерации акта сверки: ' + err.message); }
    });

    // ==========================================
    // 6. КОНТРОЛЬ ОЖИДАЕМЫХ ПЛАТЕЖЕЙ (СЧЕТА)
    // ==========================================
    router.get('/api/invoices', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT co.id, co.doc_number as invoice_number, co.pending_debt as amount,
                       c.name as counterparty_name, 'Долг по заказу' as description,
                       TO_CHAR(co.created_at, 'DD.MM.YYYY') as date_formatted
                FROM client_orders co
                LEFT JOIN counterparties c ON co.counterparty_id = c.id
                WHERE co.status != 'cancelled' AND co.status != 'completed' AND co.pending_debt > 0
                ORDER BY co.id DESC
            `);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/invoices', async (req, res) => {
        res.status(400).json({ error: 'Ручное выставление счетов отключено. Оформляйте заказы со статусом "Долг" через модуль Продаж!' });
    });

    router.post('/api/invoices/:id/pay', async (req, res) => {
        const { account_id } = req.body;
        try {
            await withTransaction(pool, async (client) => {
                const invRes = await client.query('SELECT * FROM client_orders WHERE id = $1', [req.params.id]);
                const inv = invRes.rows[0];
                if (!inv) throw new Error('Заказ не найден');
                const debt = parseFloat(inv.pending_debt);
                if (debt <= 0) throw new Error('Долг по этому заказу уже погашен!');

                // Гасим долг в заказе
                await client.query("UPDATE client_orders SET paid_amount = paid_amount + $1, pending_debt = 0 WHERE id = $2", [debt, req.params.id]);

                const vatAmount = Number(((debt * ERP_CONFIG.vatRate) / (100 + ERP_CONFIG.vatRate)).toFixed(2));
                const desc = `Оплата долга по заказу №${inv.doc_number}`;

                await client.query(`
                    INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, transaction_date)
                    VALUES ($1, 'income', 'Погашение долга', $2, $3, 'Безналичный расчет', $4, $5, NOW())
                `, [debt, desc, vatAmount, account_id, inv.counterparty_id]);
            });
            res.json({ success: true, message: 'Долг по заказу успешно погашен!' });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.delete('/api/invoices/:id', async (req, res) => {
        res.status(400).json({ error: 'Удаление платежей недоступно. Если заказ отменен, перейдите в модуль Продаж и отмените его там.' });
    });

    // ==========================================
    // 7. СЧЕТА КОМПАНИИ, ПЕРЕВОДЫ И СОЗДАНИЕ ТРАНЗАКЦИЙ
    // ==========================================
    router.get('/api/report/finance', async (req, res) => {
        try {
            const { start, end, account_id } = req.query;

            let whereClause = "WHERE COALESCE(is_deleted, false) = false ";
            whereClause += "AND category NOT IN ('Корректировка долга', 'Перевод', 'Ввод остатков') ";

            let params = [];
            let paramIdx = 1;

            if (start && end) {
                whereClause += ` AND transaction_date >= $${paramIdx} AND transaction_date <= $${paramIdx + 1}::timestamp + interval '1 day' - interval '1 second'`;
                params.push(start, end);
                paramIdx += 2;
            }

            if (account_id) {
                whereClause += ` AND account_id = $${paramIdx}`;
                params.push(account_id);
            }

            const query = `
                SELECT 
                    SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) AS income,
                    SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS expense
                FROM transactions
                ${whereClause}
            `;

            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get(['/api/accounts', '/api/finance/accounts'], async (req, res) => {
        const { end } = req.query; // Ловим дату конца периода
        try {
            const result = await pool.query('SELECT * FROM accounts ORDER BY type DESC, id ASC');
            let accounts = result.rows;

            // 🚀 МАГИЯ: ВЫЧИСЛЕНИЕ ИСТОРИЧЕСКОГО ОСТАТКА
            if (end) {
                // Берем самый конец выбранного дня
                const endDateTime = `${end} 23:59:59`;

                // Узнаем, сколько денег пришло и ушло ПОСЛЕ этой даты
                const histRes = await pool.query(`
                    SELECT account_id, 
                           SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) as future_incomes,
                           SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) as future_expenses
                    FROM transactions 
                    WHERE transaction_date > $1 AND COALESCE(is_deleted, false) = false
                    GROUP BY account_id
                `, [endDateTime]);

                const histMap = {};
                histRes.rows.forEach(r => {
                    histMap[r.account_id] = { inc: parseFloat(r.future_incomes), exp: parseFloat(r.future_expenses) };
                });

                // Отматываем текущий баланс назад: вычитаем то, что пришло позже, и возвращаем то, что ушло позже
                accounts = accounts.map(acc => {
                    if (histMap[acc.id]) {
                        const histBalance = parseFloat(acc.balance) - histMap[acc.id].inc + histMap[acc.id].exp;
                        return { ...acc, balance: histBalance };
                    }
                    return acc;
                });
            }

            res.json(accounts);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/accounts', async (req, res) => {
        const { name, type, balance } = req.body;
        try {
            await pool.query('INSERT INTO accounts (name, type, balance) VALUES ($1, $2, $3)', [name, type, balance || 0]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 🚀 ПЕРЕНЕСЕННЫЙ МАРШРУТ ИЗ WEB.JS: Переименование счета
    router.put('/api/accounts/:id', async (req, res) => {
        const { name } = req.body;
        try {
            await pool.query('UPDATE accounts SET name = $1 WHERE id = $2', [name, req.params.id]);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/api/transactions', async (req, res) => {
        const { amount, type, category, description, method, account_id, counterparty_id } = req.body;
        if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) {
            return res.status(400).json({ error: 'Сумма операции должна быть больше нуля!' });
        }

        try {
            await withTransaction(pool, async (client) => {
                await client.query(`
                    INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, transaction_date)
                    VALUES ($1, $2, $3, $4, 0, $5, $6, $7, NOW())
                `, [amount, type, category, description, method, account_id, counterparty_id || null]);
            });
            res.json({ success: true, message: 'Операция сохранена' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/api/transactions/transfer', async (req, res) => {
        const { from_id, to_id, amount, description } = req.body;
        if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Сумма перевода должна быть больше нуля!' });
        if (String(from_id) === String(to_id)) return res.status(400).json({ error: 'Нельзя перевести деньги на тот же счет!' });

        try {
            await withTransaction(pool, async (client) => {
                const comment = `Внутренний перевод: ${description}`;
                await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id, transaction_date) VALUES ($1, 'expense', 'Перевод', $2, $3, NOW())`, [amount, comment, from_id]);
                await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id, transaction_date) VALUES ($1, 'income', 'Перевод', $2, $3, NOW())`, [amount, comment, to_id]);
            });
            res.json({ success: true, message: 'Перевод выполнен' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ==========================================
    // 8. РЕДАКТИРОВАНИЕ, УДАЛЕНИЕ И ИМПОРТ 1С
    // ==========================================
    router.delete('/api/transactions/:id', async (req, res) => {
        const { id } = req.params;

        try {
            await withTransaction(pool, async (client) => {
                // 1. Сначала читаем данные транзакции, включая поле source_module
                const txRes = await client.query(
                    'SELECT amount, transaction_type, account_id, description, source_module FROM transactions WHERE id = $1',
                    [id]
                );

                if (txRes.rows.length === 0) throw new Error("Транзакция не найдена");

                const { description, source_module } = txRes.rows[0];

                // 🛡️ ГЛАВНОЕ ДОБАВЛЕНИЕ: Если платеж из зарплаты — блокируем удаление
                if (source_module === 'salary') {
                    throw new Error("Это выплата зарплаты. Удаление разрешено только в модуле 'Кадры' через историю выплат сотрудника.");
                }

                // 2. Логика с инвойсами (оставляем как было)
                const docNum = extractDocNumber(description);
                if (docNum) {
                    await client.query(`UPDATE invoices SET status = 'pending' WHERE invoice_number = $1`, [docNum]);
                }

                // 3. Софт-делет (помечаем как удаленную)
                await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [id]);
            });

            res.json({ success: true });
        } catch (err) {
            // Если это наша ошибка про зарплату — вернем статус 403 (Запрещено)
            const statusCode = err.message.includes('модуле "Кадры"') ? 403 : 500;
            res.status(statusCode).json({ error: err.message });
        }
    });

    router.put('/api/transactions/:id', async (req, res) => {
        const { id } = req.params;
        const { description, amount, category, account_id, counterparty_id, transaction_date } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                await client.query(`
                    UPDATE transactions 
                    SET description = $1, amount = $2, category = $3, account_id = $4, counterparty_id = $5, transaction_date = $6
                    WHERE id = $7
                `, [description, amount, category, account_id || null, counterparty_id || null, transaction_date, id]);
            });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Вставьте этот блок в routes/finance.js
    router.delete('/api/finance/transactions/:id', async (req, res) => {
        const { id } = req.params;

        try {
            await withTransaction(pool, async (client) => {
                // 1. Получаем данные транзакции перед удалением
                const transRes = await client.query(
                    'SELECT amount, linked_order_id, transaction_type FROM transactions WHERE id = $1',
                    [id]
                );

                if (transRes.rows.length === 0) throw new Error('Транзакция не найдена');
                const { amount, linked_order_id, transaction_type } = transRes.rows[0];

                // 2. Если транзакция привязана к заказу, обновляем paid_amount
                if (linked_order_id) {
                    // Если это был приход (income), вычитаем его из оплат заказа
                    const multiplier = (transaction_type === 'income') ? -1 : 1;
                    await client.query(
                        'UPDATE client_orders SET paid_amount = paid_amount + $1 WHERE id = $2',
                        [parseFloat(amount) * multiplier, linked_order_id]
                    );
                }

                // 3. Удаляем транзакцию
                await client.query('DELETE FROM transactions WHERE id = $1', [id]);
            });

            res.json({ success: true, message: 'Транзакция удалена, баланс заказа обновлен' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ==========================================
    // УМНЫЙ ИМПОРТ: Жесткая защита от дублей и супер-категоризация
    // ==========================================
    router.post('/api/transactions/import', async (req, res) => {
        const { account_id, transactions } = req.body;

        try {
            let importedCount = 0; let autoPaidInvoicesCount = 0;

            await withTransaction(pool, async (client) => {
                for (let tr of transactions) {
                    let cp_id = null;
                    let safeInn = tr.counterparty_inn ? String(tr.counterparty_inn).split('/')[0].split('\\')[0].trim().substring(0, 20) : null;
                    const safeName = tr.counterparty_name ? String(tr.counterparty_name).substring(0, 140) : 'Неизвестный партнер';
                    const cpType = tr.type === 'income' ? 'Покупатель' : 'Поставщик';

                    // 1. Поиск или создание контрагента
                    if (safeInn) {
                        let cpRes = await client.query('SELECT id FROM counterparties WHERE inn = $1 LIMIT 1', [safeInn]);
                        if (cpRes.rows.length > 0) cp_id = cpRes.rows[0].id;
                        else {
                            // ИСПРАВЛЕНО: используем колонку role вместо type
                            const newCp = await client.query(`INSERT INTO counterparties (name, inn, role) VALUES ($1, $2, $3) RETURNING id`, [safeName, safeInn, cpType]);
                            cp_id = newCp.rows[0].id;
                        }
                    } else {
                        let cpRes = await client.query('SELECT id FROM counterparties WHERE name = $1 LIMIT 1', [safeName]);
                        if (cpRes.rows.length > 0) cp_id = cpRes.rows[0].id;
                        else {
                            // ИСПРАВЛЕНО: используем колонку role вместо type
                            const newCp = await client.query(`INSERT INTO counterparties (name, role) VALUES ($1, $2) RETURNING id`, [safeName, cpType]);
                            cp_id = newCp.rows[0].id;
                        }
                    }
                    const txDate = tr.date; // Дата строго из выписки (уже с временем 12:00:00 от фронтенда)
                    if (!txDate) throw new Error("Система не смогла прочитать дату операции!");
                    const safeDescription = tr.description || '';

                    // 🛡️ ЖЕЛЕЗОБЕТОННАЯ ПРОВЕРКА НА ДУБЛИКАТЫ
                    // Сверяем счет, сумму, описание, тип и точную дату (игнорируя время загрузки)
                    const dupCheck = await client.query(`
                        SELECT id FROM transactions 
                        WHERE account_id = $1 AND amount = $2 AND description = $3 AND transaction_type = $4 
                        AND transaction_date::date = $5::date
                        LIMIT 1
                    `, [account_id, tr.amount, safeDescription, tr.type, txDate]);

                    // Если дубля нет — обрабатываем и сохраняем
                    // Если дубля нет — обрабатываем и сохраняем
                    if (dupCheck.rows.length === 0) {
                        let category = tr.type === 'income' ? 'Продажа продукции' : 'Закупка сырья';
                        const cpName = (tr.counterparty_name || '').toLowerCase();
                        const descLower = (tr.description || '').toLowerCase();

                        // 🚀 МАГИЯ АВТО-КАТЕГОРИЗАЦИИ ИЗ ИСТОРИИ
                        let historyCategoryFound = false;
                        if (cp_id) {
                            const lastCatCheck = await client.query(`
                                SELECT category FROM transactions 
                                WHERE counterparty_id = $1 AND category IS NOT NULL AND category != ''
                                ORDER BY transaction_date DESC LIMIT 1
                            `, [cp_id]);

                            if (lastCatCheck.rows.length > 0) {
                                category = lastCatCheck.rows[0].category;
                                historyCategoryFound = true; // Ставим флаг, что нашли в истории
                            }
                        }

                        // 🚀 ЛОГИКА "СВОЙ-ЧУЖОЙ": распознаем переводы между своими счетами
                        // (Это правило срабатывает всегда, переопределяя историю)
                        if (cpName.includes('плиттекс') ||
                            descLower.includes('собственных средств') ||
                            descLower.includes('между своими') ||
                            descLower.includes('перевод средств')) {
                            category = 'Перевод';
                        }
                        // 👇 Если история НЕ найдена, запускаем проверку по словам для расходов
                        else if (!historyCategoryFound && tr.type === 'expense') {
                            const descForCheck = descLower; // Объявляем переменную для проверки

                            if (cpName.includes('уфк') || cpName.includes('фнс') || descForCheck.includes('налог') || descForCheck.includes('енс') || descForCheck.includes('пфр') || descForCheck.includes('взносы')) category = 'Налоги, штрафы и взносы';
                            else if (descForCheck.includes('комисс') || cpName.includes('банк') || descForCheck.includes('эквайринг') || descForCheck.includes('рко')) category = 'Услуги банка и РКО';
                            else if (descForCheck.includes('аренд')) category = 'Аренда помещений';
                            else if (descForCheck.includes('займ') || descForCheck.includes('заем') || descForCheck.includes('кредит')) category = 'Возврат займов';
                            else if (descForCheck.includes('зарплат') || descForCheck.includes('аванс') || descForCheck.includes('реестр') || descForCheck.includes('оплат труда') || descForCheck.includes('ндфл')) category = 'Зарплата';
                            else if (descForCheck.includes('доставк') || descForCheck.includes('логист') || descForCheck.includes('пэк') || descForCheck.includes('сдэк') || descForCheck.includes('деловые линии')) category = 'Транспортные расходы';
                            else if (descForCheck.includes('материал') || descForCheck.includes('сырь') || descForCheck.includes('цемент') || descForCheck.includes('песок') || descForCheck.includes('арматур') || descForCheck.includes('бетон')) category = 'Закупка сырья';
                        }
                        // 👇 Если история НЕ найдена, запускаем проверку по словам для доходов
                        else if (!historyCategoryFound && tr.type === 'income') {
                            const descForCheck = descLower; // Объявляем переменную для проверки

                            if (descForCheck.includes('займ') || descForCheck.includes('заем') || descForCheck.includes('кредит')) category = 'Получение займов';
                            else if (descForCheck.includes('возврат')) category = 'Возврат средств';
                        }
                        await client.query(`
                            INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date, created_at) 
                            VALUES ($1, $2, $3, $4, 'Безналичный расчет (Импорт)', $5, $6, $7::timestamp, NOW())
                        `, [tr.amount, tr.type, category, safeDescription, account_id, cp_id, txDate]);

                        // Логика автоматического закрытия выставленных счетов
                        if (tr.type === 'income') {
                            const docNumber = extractDocNumber(safeDescription);
                            if (docNumber) {
                                const invCheck = await client.query(`SELECT id, amount FROM invoices WHERE invoice_number = $1 AND status = 'pending' ORDER BY created_at ASC`, [docNumber]);
                                if (invCheck.rows.length > 0) {
                                    let remainingAmount = parseFloat(tr.amount);
                                    for (let inv of invCheck.rows) {
                                        if (remainingAmount <= 0.01) break;
                                        const invAmt = parseFloat(inv.amount);

                                        if (remainingAmount >= invAmt - 0.01) {
                                            await client.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [inv.id]);
                                            remainingAmount -= invAmt;
                                            autoPaidInvoicesCount++;
                                        } else {
                                            await client.query(`UPDATE invoices SET amount = amount - $1 WHERE id = $2`, [remainingAmount, inv.id]);
                                            remainingAmount = 0;
                                        }
                                    }
                                }
                            }
                        }
                        importedCount++;
                    }
                }
            });
            res.json({ success: true, count: importedCount, autoPaid: autoPaidInvoicesCount });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ==========================================
    // 9. ФАЙЛЫ, ЧЕКИ И АНАЛИТИКА СЕБЕСТОИМОСТИ
    // ==========================================
    if (upload) {
        router.post('/api/transactions/:id/receipt', upload.single('receipt'), async (req, res) => {
            try {
                if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
                const fileUrl = '/uploads/' + req.file.filename;
                await pool.query('UPDATE transactions SET receipt_url = $1 WHERE id = $2', [fileUrl, req.params.id]);
                res.json({ success: true, url: fileUrl });
            } catch (err) { res.status(500).json({ error: err.message }); }
        });
    }

    router.delete('/api/transactions/:id/receipt', async (req, res) => {
        try {
            const transRes = await pool.query('SELECT receipt_url FROM transactions WHERE id = $1', [req.params.id]);
            if (transRes.rows.length > 0 && transRes.rows[0].receipt_url) {
                const filePath = path.join(__dirname, '..', 'public', transRes.rows[0].receipt_url);
                fs.unlink(filePath, (err) => {
                    if (err && err.code !== 'ENOENT') console.error('Ошибка удаления файла:', err);
                });
            }
            await pool.query('UPDATE transactions SET receipt_url = NULL WHERE id = $1', [req.params.id]);
            res.json({ success: true, message: 'Чек удален с сервера' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/analytics/profitability', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    o.doc_number,
                    o.total_amount as revenue,
                    c.name as client_name,
                    COALESCE(SUM(ABS(m.quantity) * i.current_price), 0) as material_cost
                FROM client_orders o
                JOIN counterparties c ON o.counterparty_id = c.id
                LEFT JOIN inventory_movements m ON m.description LIKE '%' || o.doc_number || '%' AND m.movement_type = 'sales_shipment'
                LEFT JOIN items i ON m.item_id = i.id
                WHERE o.status = 'completed'
                GROUP BY o.id, c.name
                ORDER BY o.created_at DESC
                LIMIT 10
            `);

            const data = result.rows.map(row => {
                const profit = parseFloat(row.revenue) - parseFloat(row.material_cost);
                const margin = row.revenue > 0 ? ((profit / row.revenue) * 100).toFixed(1) : 0;
                return { ...row, profit, margin };
            });

            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ==========================================
    // КОНСТРУКТОР СЕБЕСТОИМОСТИ (ДЛЯ ДАШБОРДА)
    // ==========================================
    router.post('/api/analytics/cost-constructor', async (req, res) => {
        const { startDate, endDate } = req.body;

        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Не указан период' });
        }

        try {
            const cyclesRes = await pool.query(`
                SELECT SUM(cycles_count) as total_cycles 
                FROM production_batches 
                WHERE created_at::date >= $1 AND created_at::date <= $2 
                  AND status != 'cancelled'
            `, [startDate, endDate]);

            const totalCycles = parseFloat(cyclesRes.rows[0].total_cycles) || 0;

            const expensesRes = await pool.query(`
                SELECT category, description, amount, TO_CHAR(transaction_date, 'DD.MM.YYYY') as date 
                FROM transactions 
                WHERE transaction_type = 'expense' 
                  AND transaction_date::date >= $1 AND transaction_date::date <= $2 
                  AND category NOT IN ('Перевод', 'Корректировка долга', 'Ввод остатков')
                  AND COALESCE(is_deleted, false) = false
                ORDER BY transaction_date DESC
            `, [startDate, endDate]);

            res.json({
                totalCycles: totalCycles,
                expenses: expensesRes.rows
            });
        } catch (err) {
            console.error('Ошибка в Конструкторе себестоимости:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ==========================================
    // 10. ПРЕДСКАЗАНИЕ КАССОВЫХ РАЗРЫВОВ (ПРОГНОЗ)
    // ==========================================
    router.get('/api/finance/cashflow-forecast', async (req, res) => {
        try {
            const accRes = await pool.query('SELECT SUM(balance) as total_balance FROM accounts');
            let currentBalance = parseFloat(accRes.rows[0].total_balance) || 0;

            const invRes = await pool.query(`
                SELECT pending_debt as amount, created_at::date + integer '3' as expected_date 
                FROM client_orders WHERE status = 'pending' OR status = 'processing'
            `);

            const expRes = await pool.query(`
                SELECT amount, date as expected_date 
                FROM planned_expenses WHERE status = 'pending'
            `);

            const forecast = [];
            let runningBalance = currentBalance;
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            for (let i = 0; i <= 30; i++) {
                const targetDate = new Date(today);
                targetDate.setDate(today.getDate() + i);
                const dateStr = targetDate.toISOString().split('T')[0];

                let dailyIncome = 0;
                let dailyExpense = 0;

                invRes.rows.forEach(inv => {
                    const invDateObj = new Date(inv.expected_date);
                    const invDate = invDateObj < today ? today.toISOString().split('T')[0] : invDateObj.toISOString().split('T')[0];
                    if (invDate === dateStr) dailyIncome += parseFloat(inv.amount);
                });

                expRes.rows.forEach(exp => {
                    const expDateObj = new Date(exp.expected_date);
                    const expDate = expDateObj < today ? today.toISOString().split('T')[0] : expDateObj.toISOString().split('T')[0];
                    if (expDate === dateStr) dailyExpense += parseFloat(exp.amount);
                });

                runningBalance = runningBalance + dailyIncome - dailyExpense;

                forecast.push({
                    date: dateStr,
                    income: dailyIncome,
                    expense: dailyExpense,
                    projected_balance: runningBalance
                });
            }

            res.json({ currentBalance, forecast });
        } catch (err) {
            console.error('Ошибка прогноза кассовых разрывов:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/api/finance/tax-piggy-bank', async (req, res) => {
        let { start, end, usn_rate } = req.query;

        // Защита от NaN: если ставка кривая, берем 3%
        const rate = parseFloat(usn_rate);
        const usnMultiplier = (isNaN(rate) ? 3 : rate) / 100;

        if (!start || !end) {
            const currentYear = new Date().getFullYear();
            start = `${currentYear}-01-01 00:00:00`;
            end = `${currentYear}-12-31 23:59:59`;
        }

        let params = [start, end];
        let where = "WHERE COALESCE(t.is_deleted, false) = false ";
        where += "AND t.category NOT IN ('Корректировка долга', 'Перевод', 'Ввод остатков') ";
        where += "AND t.transaction_date >= $1 AND t.transaction_date <= $2";

        try {
            const result = await pool.query(`
            SELECT t.*, a.type as account_type, a.name as account_name
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            ${where}
            ORDER BY t.transaction_date DESC
        `, params);

            const cashData = { transactions: [], totalTax: new Big(0), turnover: new Big(0) };
            const bankData = { transactions: [], vatIn: new Big(0), vatOut: new Big(0) };

            result.rows.forEach(t => {
                // 💎 1. Создаем объект Big сразу. parseFloat больше НЕ нужен.
                const amt = new Big(t.amount || 0);
                const descLower = (t.description || '').toLowerCase();

                // 🧠 2. Умная автоматика
                const isNoVatCat = ERP_CONFIG.noVatCategories.includes(t.category);
                const hasNoVatText = descLower.includes('без ндс') || descLower.includes('ндс не облагается');
                const hasVatText = descLower.includes('в т.ч. ндс') || descLower.includes('включая ндс');

                let autoNoVat = (isNoVatCat || hasNoVatText) && !hasVatText;

                // 🛡️ 3. Учет ручных галочек
                if (t.tax_excluded) t.is_no_vat = true;
                else if (t.tax_force_vat) t.is_no_vat = false;
                else t.is_no_vat = autoNoVat;

                if (t.account_type === 'cash') {
                    if (t.transaction_type === 'income') {
                        // Используем .times() вместо *
                        const tax = amt.times(usnMultiplier);
                        t.calculated_tax = Number(tax.toFixed(2));

                        // Используем .plus() вместо +=
                        cashData.turnover = cashData.turnover.plus(amt);
                        cashData.totalTax = cashData.totalTax.plus(tax);
                    } else {
                        t.calculated_tax = 0;
                    }
                    cashData.transactions.push(t);
                } else {
                    if (t.is_no_vat) {
                        t.calculated_tax = 0;
                    } else {
                        // 💎 4. Формула НДС через методы Big.js: amt - (amt / divider)
                        const vat = amt.times(ERP_CONFIG.vatRate).div(100 + ERP_CONFIG.vatRate);
                        t.calculated_tax = Number(vat.toFixed(2));

                        if (t.transaction_type === 'income') {
                            // Используем .plus() вместо +=
                            bankData.vatIn = bankData.vatIn.plus(vat);
                        } else {
                            bankData.vatOut = bankData.vatOut.plus(vat);
                        }
                    }
                    bankData.transactions.push(t);
                }
            });

            // 1. Сначала считаем разницу НДС как объект Big
            // bankData.vatIn и vatOut должны быть инициализированы как new Big(0) выше по коду
            const netVatBig = bankData.vatIn.minus(bankData.vatOut);

            // 2. Считаем итоговый налог (УСН + НДС если он > 0)
            // Используем netVatBig.gt(0), так как netVatBig — это объект Big.js
            const totalTaxBig = cashData.totalTax.plus(netVatBig.gt(0) ? netVatBig : new Big(0));

            // 3. Отправляем ответ, превращая всё в обычные числа только в самый последний момент
            res.json({
                summary: {
                    totalTax: Number(totalTaxBig.toFixed(2)),
                    cashTax: Number(cashData.totalTax.toFixed(2)),
                    bankVat: Number(netVatBig.toFixed(2))
                },
                cash: {
                    ...cashData,
                    totalTax: Number(cashData.totalTax.toFixed(2)),
                    turnover: Number(cashData.turnover.toFixed(2))
                },
                bank: {
                    ...bankData,
                    vatIn: Number(bankData.vatIn.toFixed(2)),
                    vatOut: Number(bankData.vatOut.toFixed(2)),
                    netVat: Number(netVatBig.toFixed(2)) // Здесь превращаем в число для фронтенда
                },
                config: {
                    vatRate: ERP_CONFIG.vatRate,
                    vatDivider: ERP_CONFIG.vatDivider
                }
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ==========================================
    // 12. СОХРАНЕНИЕ ГАЛОЧЕК В БАЗУ (МНОГОПОЛЬЗОВАТЕЛЬСКИЙ РЕЖИМ)
    // ==========================================
    router.post('/api/finance/tax-status', async (req, res) => {
        const { id, field, is_checked } = req.body;
        const allowedFields = ['tax_excluded', 'tax_force_vat'];
        if (!allowedFields.includes(field)) {
            return res.status(400).json({ error: 'Блокировка: недопустимое поле базы данных' });
        }

        try {
            await pool.query(`UPDATE transactions SET ${field} = $1 WHERE id = $2`, [is_checked, id]);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/api/finance/tax-settings', async (req, res) => {
        const { key, value } = req.body;
        try {
            await pool.query(`
                INSERT INTO global_settings (setting_key, setting_value) 
                VALUES ($1, $2) 
                ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
            `, [key, value.toString()]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/finance/tax-settings', async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM global_settings');
            const settings = {};
            // Превращаем строки из таблицы в удобный объект для фронтенда
            result.rows.forEach(r => {
                settings[r.setting_key] = r.setting_value;
            });
            res.json(settings);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // --- АВТО-КАТЕГОРИЗАЦИЯ ---
    // Получаем последнюю категорию по ID контрагента
    router.get('/api/finance/last-category', async (req, res) => {
        // 1. Ловим ID контрагента из запроса
        const { counterparty_id } = req.query;
        if (!counterparty_id) return res.json({ category: null });

        try {
            // 2. Ищем последнюю не удаленную операцию с этим ID, где есть категория
            const result = await pool.query(`
            SELECT category 
            FROM transactions 
            WHERE counterparty_id = $1 
              AND category IS NOT NULL 
              AND category != ''
              AND COALESCE(is_deleted, false) = false
            ORDER BY transaction_date DESC 
            LIMIT 1
        `, [counterparty_id]);

            // 3. Возвращаем результат на фронтенд
            if (result.rows.length > 0) {
                res.json({ category: result.rows[0].category });
            } else {
                res.json({ category: null });
            }
        } catch (err) {
            console.error('Ошибка авто-категоризации:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};