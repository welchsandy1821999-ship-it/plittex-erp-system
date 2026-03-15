const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// 👈 Добавили withTransaction
module.exports = function (pool, upload, withTransaction) {

    // ==========================================
    // 1. ОТЧЕТ P&L (ПРИБЫЛИ И УБЫТКИ)
    // ==========================================
    router.get('/api/finance/pnl', async (req, res) => {
        const { start, end } = req.query;
        let params = [];

        let where = "WHERE COALESCE(is_deleted, false) = false ";
        where += "AND category NOT IN ('Корректировка долга', 'Ввод остатков') ";

        if (start && end) {
            where += ` AND transaction_date::date >= $1 AND transaction_date::date <= $2`;
            params = [start, end];
        }
        try {
            const transRes = await pool.query(`SELECT category, transaction_type, SUM(amount) as total FROM transactions ${where} GROUP BY category, transaction_type`, params);

            let revenue = 0; let directCosts = 0; let indirectCosts = 0;
            const directCategories = ['Закупка сырья', 'Зарплата'];

            transRes.rows.forEach(r => {
                const amt = parseFloat(r.total);
                if (r.transaction_type === 'income') revenue += amt;
                else {
                    if (directCategories.includes(r.category)) directCosts += amt;
                    else indirectCosts += amt;
                }
            });

            const grossProfit = revenue - directCosts;
            const netProfit = grossProfit - indirectCosts;
            const margin = revenue > 0 ? ((netProfit / revenue) * 100).toFixed(1) : 0;

            res.json({ revenue, directCosts, indirectCosts, grossProfit, netProfit, margin });
        } catch (err) {
            res.status(500).json({ error: err.message });
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
                    INSERT INTO transactions (account_id, amount, transaction_type, category, description, transaction_date)
                    VALUES ($1, $2, 'expense', $3, $4, NOW())
                `, [account_id, exp.amount, exp.category, desc]);

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
        const { search, start, end, account_id, page, limit } = req.query;
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

            // Безопасные прямые запросы
            const countRes = await pool.query(`SELECT COUNT(*) FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id ${whereClause}`, params);
            const totalRecords = parseInt(countRes.rows[0].count);

            const dataQuery = `
                SELECT t.id, t.transaction_date, t.amount, t.transaction_type, 
                       t.category, t.description, t.payment_method, t.vat_amount,
                       t.counterparty_id,
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

                        const invoiceMatch = (description || '').match(/(СЧ|ЗК)-(\d+)/i);
                        if (invoiceMatch) {
                            await client.query(`UPDATE invoices SET status = 'pending' WHERE invoice_number = $1`, [invoiceMatch[0].toUpperCase()]);
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
        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
            if (cpRes.rows.length === 0) return res.status(404).json({ error: 'Контрагент не найден' });

            const transRes = await pool.query(`
                SELECT amount, transaction_type, category, description, 
                       TO_CHAR(transaction_date, 'DD.MM.YYYY HH24:MI') as date 
                FROM transactions 
                WHERE counterparty_id = $1 AND COALESCE(is_deleted, false) = false
                ORDER BY transaction_date DESC, id DESC
            `, [cpId]);

            let invoices = [];
            try {
                const invRes = await pool.query(`
                    SELECT id, amount, invoice_number, description, status, 
                           TO_CHAR(created_at, 'DD.MM.YYYY') as date 
                    FROM invoices WHERE counterparty_id = $1 ORDER BY created_at DESC
                `, [cpId]);
                invoices = invRes.rows;
            } catch (e) { }

            let contracts = [];
            try {
                const conRes = await pool.query(`
                    SELECT id, number, TO_CHAR(date, 'DD.MM.YYYY') as date 
                    FROM contracts WHERE counterparty_id = $1 ORDER BY date DESC
                `, [cpId]);
                contracts = conRes.rows;
            } catch (e) { }

            res.json({ info: cpRes.rows[0], transactions: transRes.rows, invoices: invoices, contracts: contracts });
        } catch (err) {
            console.error('Ошибка загрузки профиля:', err);
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
                SELECT i.*, c.name as counterparty_name,
                       TO_CHAR(i.created_at, 'DD.MM.YYYY') as date_formatted
                FROM invoices i
                JOIN counterparties c ON i.counterparty_id = c.id
                WHERE i.status = 'pending'
                ORDER BY i.id DESC
            `);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/invoices', async (req, res) => {
        const { cp_id, amount, desc, num } = req.body;
        if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) {
            return res.status(400).json({ error: 'Сумма счета должна быть больше нуля!' });
        }
        try {
            await pool.query(`
                INSERT INTO invoices (counterparty_id, invoice_number, amount, description, status)
                VALUES ($1, $2, $3, $4, 'pending')
            `, [cp_id, num, amount, desc]);
            res.json({ success: true, message: 'Счет успешно выставлен' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/invoices/:id/pay', async (req, res) => {
        const { account_id } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                const invRes = await client.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
                const inv = invRes.rows[0];
                if (!inv) throw new Error('Счет не найден');
                if (parseFloat(inv.amount) <= 0) throw new Error('Критическая ошибка: сумма счета меньше или равна нулю!');

                await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [req.params.id]);

                const vatAmount = (inv.amount * 22) / 122;
                const desc = `Оплата по счету №${inv.invoice_number}. ${inv.description || ''}`;

                await client.query(`
                    INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, transaction_date)
                    VALUES ($1, 'income', 'Продажа продукции', $2, $3, 'Безналичный расчет', $4, $5, NOW())
                `, [inv.amount, desc, vatAmount, account_id, inv.counterparty_id]);
            });
            res.json({ success: true, message: 'Счет успешно оплачен' });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.delete('/api/invoices/:id', async (req, res) => {
        try {
            await withTransaction(pool, async (client) => {
                const invRes = await client.query('SELECT status FROM invoices WHERE id = $1', [req.params.id]);
                if (invRes.rows.length > 0) {
                    if (invRes.rows[0].status === 'paid') {
                        throw new Error('СИСТЕМНАЯ БЛОКИРОВКА: Этот счет уже оплачен! Сначала найдите и удалите сам платеж (поступление) во вкладке "История операций", чтобы деньги списались с баланса. Только после этого можно удалить счет.');
                    }
                    await client.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
                }
            });
            res.json({ success: true });
        } catch (err) {
            // Чтобы пробросить ошибку системной блокировки с нормальным статусом
            res.status(err.message.includes('СИСТЕМНАЯ БЛОКИРОВКА') ? 400 : 500).json({ error: err.message });
        }
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

    router.get('/api/accounts', async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM accounts ORDER BY id ASC');
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/accounts', async (req, res) => {
        const { name, type, balance } = req.body;
        try {
            await pool.query('INSERT INTO accounts (name, type, balance) VALUES ($1, $2, $3)', [name, type, balance || 0]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
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
                const txRes = await client.query('SELECT amount, transaction_type, account_id, description FROM transactions WHERE id = $1', [id]);
                if (txRes.rows.length === 0) throw new Error("Транзакция не найдена");

                const { description } = txRes.rows[0];

                const invoiceMatch = (description || '').match(/(СЧ|ЗК)-(\d+)/i);
                if (invoiceMatch) {
                    const invoiceNumber = invoiceMatch[0].toUpperCase();
                    await client.query(`UPDATE invoices SET status = 'pending' WHERE invoice_number = $1`, [invoiceNumber]);
                }

                await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [id]);
            });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.put('/api/transactions/:id', async (req, res) => {
        const { id } = req.params;
        const { description, amount, category, account_id, counterparty_id, transaction_date } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                const oldRes = await client.query('SELECT amount, transaction_type, account_id FROM transactions WHERE id = $1', [id]);
                const old = oldRes.rows[0];

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

    router.post('/api/transactions/import', async (req, res) => {
        const { account_id, transactions } = req.body;

        try {
            let importedCount = 0; let autoPaidInvoicesCount = 0;

            await withTransaction(pool, async (client) => {
                for (let tr of transactions) {
                    let cp_id = null;
                    let safeInn = null;
                    if (tr.counterparty_inn) safeInn = String(tr.counterparty_inn).split('/')[0].split('\\')[0].trim().substring(0, 20);
                    const safeName = tr.counterparty_name ? String(tr.counterparty_name).substring(0, 140) : 'Неизвестный партнер';
                    const cpType = tr.type === 'income' ? 'Покупатель' : 'Поставщик';

                    if (safeInn) {
                        let cpRes = await client.query('SELECT id FROM counterparties WHERE inn = $1 LIMIT 1', [safeInn]);
                        if (cpRes.rows.length > 0) cp_id = cpRes.rows[0].id;
                        else {
                            const newCp = await client.query(`INSERT INTO counterparties (name, inn, type) VALUES ($1, $2, $3) RETURNING id`, [safeName, safeInn, cpType]);
                            cp_id = newCp.rows[0].id;
                        }
                    } else {
                        let cpRes = await client.query('SELECT id FROM counterparties WHERE name = $1 LIMIT 1', [safeName]);
                        if (cpRes.rows.length > 0) cp_id = cpRes.rows[0].id;
                        else {
                            const newCp = await client.query(`INSERT INTO counterparties (name, type) VALUES ($1, $2) RETURNING id`, [safeName, cpType]);
                            cp_id = newCp.rows[0].id;
                        }
                    }

                    const txDate = tr.date;
                    if (!txDate) throw new Error("Браузер прислал пустую дату!");

                    const safeDescription = tr.description || '';

                    const dupCheck = await client.query(`
                        SELECT id FROM transactions 
                        WHERE account_id = $1 AND amount = $2 AND description = $3 AND transaction_type = $4 
                        AND (created_at::date = $5::date OR transaction_date::date = $5::date)
                        LIMIT 1
                    `, [account_id, tr.amount, safeDescription, tr.type, txDate]);

                    if (dupCheck.rows.length === 0) {
                        let category = tr.type === 'income' ? 'Продажа продукции' : 'Закупка сырья';
                        const cpName = (tr.counterparty_name || '').toLowerCase();
                        const descForCheck = safeDescription.toLowerCase();

                        if (tr.type === 'expense') {
                            if (cpName.includes('уфк') || cpName.includes('казначейство') || descForCheck.includes('налог') || descForCheck.includes('взыскан') || descForCheck.includes('пфр')) category = 'Налоги, штрафы и взносы';
                            else if (descForCheck.includes('комисс') || cpName.includes('банк') || descForCheck.includes('рко')) category = 'Услуги банка и РКО';
                            else if (descForCheck.includes('аренд')) category = 'Аренда помещений';
                            else if (descForCheck.includes('займ') || descForCheck.includes('заем') || descForCheck.includes('кредит')) category = 'Возврат займов';
                            else if (descForCheck.includes('зарплат') || descForCheck.includes('оплат труда') || descForCheck.includes('аванс') || descForCheck.includes('ндфл')) category = 'Зарплата';
                            else if (descForCheck.includes('материал') || descForCheck.includes('сырь') || descForCheck.includes('цемент') || descForCheck.includes('песок') || descForCheck.includes('щебень')) category = 'Закупка сырья';
                            else if (descForCheck.includes('доставк') || descForCheck.includes('транспорт') || descForCheck.includes('логист')) category = 'Транспортные расходы';
                        } else if (tr.type === 'income') {
                            if (descForCheck.includes('займ') || descForCheck.includes('заем') || descForCheck.includes('кредит')) category = 'Получение займов';
                            else if (descForCheck.includes('возврат')) category = 'Возврат средств';
                        }

                        await client.query(`
                            INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date, created_at) 
                            VALUES ($1, $2, $3, $4, 'Безналичный расчет (Импорт)', $5, $6, $7::timestamp, $7::timestamp)
                        `, [tr.amount, tr.type, category, safeDescription, account_id, cp_id, txDate]);

                        if (tr.type === 'income') {
                            const invoiceMatch = safeDescription.match(/(СЧ|ЗК)-(\d+)/i);
                            if (invoiceMatch) {
                                const docNumber = invoiceMatch[0].toUpperCase();
                                const invCheck = await client.query(`SELECT id, amount FROM invoices WHERE invoice_number = $1 AND status = 'pending' ORDER BY created_at ASC`, [docNumber]);
                                if (invCheck.rows.length > 0) {
                                    let remainingAmount = parseFloat(tr.amount);
                                    for (let inv of invCheck.rows) {
                                        if (remainingAmount <= 0) break;
                                        if (remainingAmount >= parseFloat(inv.amount)) {
                                            await client.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [inv.id]);
                                            remainingAmount -= parseFloat(inv.amount);
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
            // 1. Считаем общее количество циклов за выбранный период
            // Берем данные из партий, которые были произведены в эти даты
            const cyclesRes = await pool.query(`
                SELECT SUM(cycles_count) as total_cycles 
                FROM production_batches 
                WHERE created_at::date >= $1 AND created_at::date <= $2 
                  AND status != 'cancelled'
            `, [startDate, endDate]);

            const totalCycles = parseFloat(cyclesRes.rows[0].total_cycles) || 0;

            // 2. Получаем все расходы (expense) за этот же период
            // Исключаем удаленные транзакции и переводы между своими счетами
            const expensesRes = await pool.query(`
                SELECT category, description, amount, TO_CHAR(transaction_date, 'DD.MM.YYYY') as date 
                FROM transactions 
                WHERE transaction_type = 'expense' 
                  AND transaction_date::date >= $1 AND transaction_date::date <= $2 
                  AND category NOT IN ('Перевод', 'Корректировка долга', 'Ввод остатков')
                  AND COALESCE(is_deleted, false) = false
                ORDER BY transaction_date DESC
            `, [startDate, endDate]);

            // Отправляем готовый JSON обратно в dashboard.js
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
                SELECT amount, created_at::date + integer '3' as expected_date 
                FROM invoices WHERE status = 'pending'
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

    // ==========================================
    // 11. ПРЕДВИНУТАЯ НАЛОГОВАЯ КОПИЛКА (УРОВЕНЬ ERP)
    // ==========================================
    router.get('/api/finance/tax-piggy-bank', async (req, res) => {
        let { start, end, usn_rate } = req.query;
        const usnRate = usn_rate ? parseFloat(usn_rate) : 3;
        const usnMultiplier = usnRate / 100;

        if (!start || !end) {
            const currentYear = new Date().getFullYear();
            start = `${currentYear}-01-01 00:00:00`;
            end = `${currentYear}-12-31 23:59:59`;
            console.log(`[TAX PIGGY BANK] Защита памяти: применен дефолтный период ${currentYear} год.`);
        }

        let params = [];
        let where = "WHERE COALESCE(t.is_deleted, false) = false ";
        where += "AND t.category NOT IN ('Корректировка долга', 'Перевод', 'Ввод остатков') ";

        if (start && end) {
            where += ` AND t.transaction_date >= $1 AND t.transaction_date <= $2`;
            params = [start, end];
        }
        try {
            const result = await pool.query(`
                SELECT t.*, a.type as account_type, a.name as account_name
                FROM transactions t
                JOIN accounts a ON t.account_id = a.id
                ${where}
                ORDER BY t.transaction_date DESC
            `, params);

            const cashData = { transactions: [], totalTax: 0, turnover: 0 };
            const bankData = { transactions: [], vatIn: 0, vatOut: 0, netVat: 0 };

            const noVatCategories = ['Зарплата', 'Налоги, штрафы и взносы', 'Услуги банка и РКО', 'Возврат займов', 'Получение займов'];

            result.rows.forEach(t => {
                const amt = parseFloat(t.amount);
                const descLower = (t.description || '').toLowerCase();
                t.is_no_vat = noVatCategories.includes(t.category) || descLower.includes('без ндс');

                if (t.account_type === 'cash') {
                    if (t.transaction_type === 'income') {
                        const tax = amt * usnMultiplier;
                        t.calculated_tax = tax;
                        cashData.turnover += amt;
                        cashData.totalTax += tax;
                        cashData.transactions.push(t);
                    } else {
                        t.calculated_tax = 0;
                        cashData.transactions.push(t);
                    }
                } else {
                    if (t.is_no_vat) t.calculated_tax = 0;
                    else {
                        const vat = (amt * 22) / 122;
                        t.calculated_tax = vat;
                        if (t.transaction_type === 'income') bankData.vatIn += vat;
                        else bankData.vatOut += vat;
                    }
                    bankData.transactions.push(t);
                }
            });

            bankData.netVat = bankData.vatIn - bankData.vatOut;

            res.json({
                summary: {
                    totalTax: cashData.totalTax + Math.max(0, bankData.netVat),
                    cashTax: cashData.totalTax,
                    bankVat: bankData.netVat
                },
                cash: cashData,
                bank: bankData
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
            result.rows.forEach(r => settings[r.setting_key] = r.setting_value);
            res.json(settings);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    return router;
};