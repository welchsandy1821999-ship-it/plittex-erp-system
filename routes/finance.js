// === ФАЙЛ: routes/finance.js (Бэкенд-маршруты Финансов и Транзакций) ===
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

module.exports = function (pool, upload) {

    // ==========================================
    // 1. ОТЧЕТ P&L (ПРИБЫЛИ И УБЫТКИ)
    // ==========================================
    router.get('/api/finance/pnl', async (req, res) => {
        const { start, end } = req.query;
        let params = []; let where = 'WHERE 1=1';
        if (start && end) {
            where += ` AND created_at::date >= $1 AND created_at::date <= $2`;
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
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const expRes = await client.query("UPDATE planned_expenses SET status = 'paid' WHERE id = $1 RETURNING *", [req.params.id]);
            if (expRes.rows.length === 0) throw new Error('Платеж не найден');
            const exp = expRes.rows[0];

            // ВАЛИДАЦИЯ: Защита от отрицательных списаний
            if (parseFloat(exp.amount) <= 0) throw new Error('Сумма платежа должна быть больше нуля');

            const desc = `Оплата плана: ${exp.category} (${exp.description || ''})`;
            await client.query(`
                INSERT INTO transactions (account_id, amount, transaction_type, category, description, date)
                VALUES ($1, $2, 'expense', $3, $4, CURRENT_DATE)
            `, [account_id, exp.amount, exp.category, desc]);

            await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [exp.amount, account_id]);

            if (exp.is_recurring) {
                const nextDate = new Date(exp.date);
                nextDate.setMonth(nextDate.getMonth() + 1);
                await client.query(
                    'INSERT INTO planned_expenses (date, amount, category, description, is_recurring, status) VALUES ($1, $2, $3, $4, $5, $6)',
                    [nextDate, exp.amount, exp.category, exp.description, true, 'pending']
                );
            }

            await client.query('COMMIT');
            res.json({ success: true, message: 'Платеж успешно проведен' });
        } catch (e) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: e.message });
        } finally { client.release(); }
    });

    // ==========================================
    // 3. ТРАНЗАКЦИИ И МАССОВОЕ УДАЛЕНИЕ
    // ==========================================
    router.get('/api/transactions', async (req, res) => {
        const { search, startDate, endDate, account_id, page, limit } = req.query;
        const parsedPage = parseInt(page) || 1;
        const parsedLimit = parseInt(limit) || 20;
        const offset = Math.max((parsedPage - 1) * parsedLimit, 0);

        const client = await pool.connect();
        try {
            let conditions = []; let params = []; let paramIndex = 1;

            if (search && String(search).trim() !== '') {
                conditions.push(`(t.description ILIKE $${paramIndex} OR t.category ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex})`);
                params.push(`%${String(search).trim()}%`);
                paramIndex++;
            }
            if (startDate && endDate) {
                conditions.push(`t.transaction_date >= $${paramIndex}::timestamp AND t.transaction_date <= $${paramIndex + 1}::timestamp + interval '1 day' - interval '1 second'`);
                params.push(startDate, endDate);
                paramIndex += 2;
            }
            if (account_id && account_id !== 'null' && account_id !== 'undefined') {
                conditions.push(`t.account_id = $${paramIndex}`);
                params.push(parseInt(account_id));
                paramIndex++;
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            const countRes = await client.query(`SELECT COUNT(*) FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id ${whereClause}`, params);
            const totalRecords = parseInt(countRes.rows[0].count);

            const dataQuery = `
                SELECT t.id, t.transaction_date, t.amount, t.transaction_type, 
                       t.category, t.description, t.payment_method, t.vat_amount,
                       c.name as counterparty_name, a.name as account_name
                FROM transactions t
                LEFT JOIN counterparties c ON t.counterparty_id = c.id
                LEFT JOIN accounts a ON t.account_id = a.id
                ${whereClause} ORDER BY t.transaction_date DESC, t.id DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
            `;
            const dataParams = [...params, parsedLimit, offset];
            const dataRes = await client.query(dataQuery, dataParams);

            res.json({
                data: dataRes.rows,
                pagination: { total: totalRecords, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(totalRecords / parsedLimit) || 1 }
            });
        } catch (err) {
            console.error('Ошибка загрузки транзакций:', err);
            res.status(500).json({ error: 'Ошибка сервера при загрузке данных' });
        } finally { client.release(); }
    });

    router.post('/api/transactions/bulk-delete', async (req, res) => {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Не переданы ID для удаления' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const transRes = await client.query('SELECT id, amount, transaction_type, account_id, description FROM transactions WHERE id = ANY($1::int[])', [ids]);

            for (const trans of transRes.rows) {
                if (trans.account_id) {
                    const balanceChange = trans.transaction_type === 'income' ? -trans.amount : trans.amount;
                    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, trans.account_id]);
                }
                if (trans.transaction_type === 'income' && trans.description) {
                    const invoiceMatch = trans.description.match(/(СЧ|ЗК)-\d+/i);
                    if (invoiceMatch) {
                        const docNumber = invoiceMatch[0].toUpperCase();
                        const invRes = await client.query(`SELECT id, status, amount FROM invoices WHERE invoice_number = $1 ORDER BY id DESC LIMIT 1`, [docNumber]);
                        if (invRes.rows.length > 0) {
                            const inv = invRes.rows[0];
                            if (inv.status === 'paid') await client.query(`UPDATE invoices SET status = 'pending' WHERE id = $1`, [inv.id]);
                            else await client.query(`UPDATE invoices SET amount = amount + $1 WHERE id = $2`, [trans.amount, inv.id]);
                        }
                    }
                }
            }
            await client.query('DELETE FROM salary_payments WHERE linked_transaction_id = ANY($1::int[])', [ids]);
            await client.query('DELETE FROM transactions WHERE id = ANY($1::int[])', [ids]);

            await client.query('COMMIT');
            res.json({ success: true, deletedCount: transRes.rows.length });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: 'Ошибка массового удаления: ' + err.message });
        } finally { client.release(); }
    });

    // ==========================================
    // 4. КАТЕГОРИИ ТРАНЗАКЦИЙ
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
    // 5. КОНТРАГЕНТЫ (CRM)
    // ==========================================
    router.get('/api/counterparties', async (req, res) => {
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
        } catch (err) { res.status(500).json({ error: err.message }); }
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

        // ВАЛИДАЦИЯ: Защита от создания счетов с отрицательной или нулевой суммой
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
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const invRes = await client.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
            const inv = invRes.rows[0];
            if (!inv) throw new Error('Счет не найден');

            // ВАЛИДАЦИЯ: На всякий случай проверяем сумму из базы перед зачислением
            if (parseFloat(inv.amount) <= 0) {
                throw new Error('Критическая ошибка: сумма счета меньше или равна нулю!');
            }

            // 1. Закрываем счет
            await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [req.params.id]);

            // 2. Создаем приходную операцию (доход)
            const vatAmount = (inv.amount * 22) / 122;
            const desc = `Оплата по счету №${inv.invoice_number}. ${inv.description || ''}`;

            await client.query(`
                INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id)
                VALUES ($1, 'income', 'Продажа продукции', $2, $3, 'Безналичный расчет', $4, $5)
            `, [inv.amount, desc, vatAmount, account_id, inv.counterparty_id]);

            // 3. Обновляем баланс банка
            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [inv.amount, account_id]);

            await client.query('COMMIT');
            res.json({ success: true, message: 'Счет успешно оплачен' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally { client.release(); }
    });

    router.delete('/api/invoices/:id', async (req, res) => {
        try {
            await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
            res.json({ success: true, message: 'Счет удален' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ==========================================
    // 7. АНАЛИТИКА, СЧЕТА КОМПАНИИ И ПЕРЕВОДЫ
    // ==========================================
    router.get('/api/report/finance', async (req, res) => {
        const { start, end } = req.query;
        let where = ''; let params = [];
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
        } catch (err) { res.status(500).json({ error: 'Ошибка аналитики: ' + err.message }); }
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

    // ВАЛИДАЦИЯ: Создание транзакции
    router.post('/api/transactions', async (req, res) => {
        const { amount, type, category, description, method, account_id, counterparty_id } = req.body;
        if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) {
            return res.status(400).json({ error: 'Сумма операции должна быть больше нуля!' });
        }
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
            res.json({ success: true, message: 'Операция сохранена' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    // ВАЛИДАЦИЯ: Внутренний перевод
    router.post('/api/transactions/transfer', async (req, res) => {
        const { from_id, to_id, amount, description } = req.body;
        if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Сумма перевода должна быть больше нуля!' });
        if (String(from_id) === String(to_id)) return res.status(400).json({ error: 'Нельзя перевести деньги на тот же счет!' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const comment = `Внутренний перевод: ${description}`;

            await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, from_id]);
            await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id) VALUES ($1, 'expense', 'Перевод', $2, $3)`, [amount, comment, from_id]);

            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, to_id]);
            await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id) VALUES ($1, 'income', 'Перевод', $2, $3)`, [amount, comment, to_id]);

            await client.query('COMMIT');
            res.json({ success: true, message: 'Перевод выполнен' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    // ==========================================
    // 8. РЕДАКТИРОВАНИЕ, УДАЛЕНИЕ И ИМПОРТ 1С
    // ==========================================
    router.delete('/api/transactions/:id', async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const transId = req.params.id;

            const transRes = await client.query('SELECT amount, transaction_type, account_id, description FROM transactions WHERE id = $1', [transId]);
            if (transRes.rows.length === 0) throw new Error('Транзакция не найдена');
            const trans = transRes.rows[0];

            await client.query('DELETE FROM salary_payments WHERE linked_transaction_id = $1', [transId]);

            if (trans.account_id) {
                const balanceChange = trans.transaction_type === 'income' ? -trans.amount : trans.amount;
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, trans.account_id]);
            }

            if (trans.transaction_type === 'income' && trans.description) {
                const invoiceMatch = trans.description.match(/(СЧ|ЗК)-\d+/i);
                if (invoiceMatch) {
                    const docNumber = invoiceMatch[0].toUpperCase();
                    const invRes = await client.query(`SELECT id, status, amount FROM invoices WHERE invoice_number = $1 ORDER BY id DESC LIMIT 1`, [docNumber]);
                    if (invRes.rows.length > 0) {
                        const inv = invRes.rows[0];
                        if (inv.status === 'paid') await client.query(`UPDATE invoices SET status = 'pending' WHERE id = $1`, [inv.id]);
                        else await client.query(`UPDATE invoices SET amount = amount + $1 WHERE id = $2`, [trans.amount, inv.id]);
                    }
                }
            }

            await client.query('DELETE FROM transactions WHERE id = $1', [transId]);
            await client.query('COMMIT');
            res.json({ success: true, message: 'Транзакция удалена' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    router.put('/api/transactions/:id', async (req, res) => {
        const transId = req.params.id;
        const { description, amount, category, account_id, counterparty_id } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const oldTrans = await client.query('SELECT amount, transaction_type, account_id FROM transactions WHERE id = $1', [transId]);
            if (oldTrans.rows.length === 0) throw new Error('Транзакция не найдена');
            const old = oldTrans.rows[0];

            if (old.account_id) {
                const revertAmount = old.transaction_type === 'income' ? -old.amount : old.amount;
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [revertAmount, old.account_id]);
            }

            await client.query(`
                UPDATE transactions SET description = $1, amount = $2, category = $3, account_id = $4, counterparty_id = $5 WHERE id = $6
            `, [description, amount, category, account_id, counterparty_id || null, transId]);

            if (account_id) {
                const applyAmount = old.transaction_type === 'income' ? amount : -amount;
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [applyAmount, account_id]);
            }

            await client.query('COMMIT');
            res.json({ success: true, message: 'Обновлено' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    router.post('/api/transactions/import', async (req, res) => {
        // Твоя гигантская логика импорта 1С осталась без изменений, 
        // просто завернута в JSON ответы для совместимости.
        const { account_id, transactions } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            let importedCount = 0; let autoPaidInvoicesCount = 0;
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

                const dupCheck = await client.query(`SELECT id FROM transactions WHERE account_id = $1 AND amount = $2 AND description = $3 AND transaction_type = $4 AND created_at::date = $5::date LIMIT 1`, [account_id, tr.amount, tr.description, tr.type, tr.date || new Date()]);

                if (dupCheck.rows.length === 0) {
                    let category = tr.type === 'income' ? 'Продажа продукции' : 'Закупка сырья';
                    const desc = (tr.description || '').toLowerCase();
                    const cpName = (tr.counterparty_name || '').toLowerCase();

                    if (tr.type === 'expense') {
                        if (cpName.includes('уфк') || cpName.includes('казначейство') || desc.includes('налог') || desc.includes('взыскан') || desc.includes('росп')) category = 'Налоги, штрафы и взносы';
                        else if (desc.includes('лицензион') || desc.includes('комисс') || cpName.includes('банк')) category = 'Услуги банка и РКО';
                        else if (desc.includes('аренд')) category = 'Аренда помещений';
                        else if (desc.includes('займ') || desc.includes('заем')) category = 'Возврат займов';
                        else if (desc.includes('зарплат') || desc.includes('оплат труда') || desc.includes('аванс')) category = 'Зарплата';
                        else if (desc.includes('материал') || desc.includes('сырь') || desc.includes('цемент')) category = 'Закупка сырья';
                    } else if (tr.type === 'income') {
                        if (desc.includes('займ') || desc.includes('заем')) category = 'Получение займов';
                        else if (desc.includes('возврат')) category = 'Возврат средств';
                    }

                    await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, created_at) VALUES ($1, $2, $3, $4, 'Безналичный расчет (Импорт)', $5, $6, COALESCE($7, CURRENT_TIMESTAMP))`, [tr.amount, tr.type, category, tr.description, account_id, cp_id, tr.date]);

                    const balanceChange = tr.type === 'income' ? tr.amount : -tr.amount;
                    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, account_id]);

                    if (tr.type === 'income') {
                        const invoiceMatch = tr.description.match(/(СЧ|ЗК)-(\d+)/i);
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
            await client.query('COMMIT');
            res.json({ success: true, count: importedCount, autoPaid: autoPaidInvoicesCount });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    // Маршруты для чеков требуют upload, который мы передали в роутер
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
                // Физическое удаление файла с диска
                const filePath = path.join(__dirname, '..', 'public', transRes.rows[0].receipt_url);
                fs.unlink(filePath, (err) => {
                    if (err && err.code !== 'ENOENT') console.error('Ошибка удаления файла:', err);
                });
            }
            await pool.query('UPDATE transactions SET receipt_url = NULL WHERE id = $1', [req.params.id]);
            res.json({ success: true, message: 'Чек удален с сервера' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // И добавь сюда аналитику себестоимости (она относится к финансам):
    router.post('/api/analytics/cost-constructor', async (req, res) => {
        const { startDate, endDate } = req.body;
        const client = await pool.connect();
        try {
            const expRes = await client.query(`SELECT id, category, description, amount, created_at::date as date FROM transactions WHERE transaction_type = 'expense' AND created_at::date >= $1 AND created_at::date <= $2 ORDER BY created_at DESC`, [startDate, endDate]);
            const cyclesRes = await client.query(`SELECT COALESCE(SUM(cycles_count), 0) as total_cycles FROM production_batches WHERE status = 'completed' AND created_at::date >= $1 AND created_at::date <= $2`, [startDate, endDate]);
            res.json({ expenses: expRes.rows, totalCycles: parseFloat(cyclesRes.rows[0].total_cycles) });
        } catch (err) { res.status(500).json({ error: err.message }); } finally { client.release(); }
    });

    // ==========================================
    // 9. КОНТРАГЕНТЫ (CRM) И АКТ СВЕРКИ
    // ==========================================
    router.post('/api/counterparties', async (req, res) => {
        const { name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name, price_level } = req.body;
        try {
            await pool.query(`
                INSERT INTO counterparties (name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name, price_level) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            `, [name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name, price_level || 'basic']);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.put('/api/counterparties/:id', async (req, res) => {
        const { name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name, price_level } = req.body;
        try {
            await pool.query(`
                UPDATE counterparties SET name=$1, type=$2, inn=$3, kpp=$4, ogrn=$5, legal_address=$6, phone=$7, email=$8, bank_name=$9, bik=$10, checking_account=$11, director_name=$12, price_level=$13 WHERE id=$14
            `, [name, type, inn, kpp, ogrn, legal_address, phone, email, bank_name, bik, checking_account, director_name, price_level || 'basic', req.params.id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete('/api/counterparties/:id', async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('UPDATE transactions SET counterparty_id = NULL WHERE counterparty_id = $1', [req.params.id]);
            await client.query('DELETE FROM counterparties WHERE id = $1', [req.params.id]);
            await client.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    router.get('/api/counterparties/:id/profile', async (req, res) => {
        const cpId = req.params.id;
        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
            if (cpRes.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
            const cp = cpRes.rows[0];

            const transRes = await pool.query(`SELECT id, amount, transaction_type, category, description, TO_CHAR(created_at, 'DD.MM.YYYY') as date FROM transactions WHERE counterparty_id = $1 ORDER BY created_at DESC`, [cpId]);
            const invRes = await pool.query(`SELECT id, invoice_number, amount, description, status, TO_CHAR(created_at, 'DD.MM.YYYY') as date FROM invoices WHERE counterparty_id = $1 ORDER BY id DESC`, [cpId]);
            const contractsRes = await pool.query(`SELECT id, number, TO_CHAR(date, 'DD.MM.YYYY') as date FROM contracts WHERE counterparty_id = $1 ORDER BY date DESC`, [cpId]);

            res.json({ info: cp, transactions: transRes.rows, invoices: invRes.rows, contracts: contractsRes.rows });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Возвращаем HTML (для печати)
    router.get('/print/act', async (req, res) => {
        const { cp_id } = req.query;
        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cp_id]);
            if (cpRes.rows.length === 0) return res.status(404).send('Контрагент не найден');
            const transRes = await pool.query(`SELECT amount, transaction_type, category, description, TO_CHAR(created_at, 'DD.MM.YYYY') as date FROM transactions WHERE counterparty_id = $1 ORDER BY created_at ASC`, [cp_id]);
            res.render('docs/act', { cp: cpRes.rows[0], transactions: transRes.rows });
        } catch (err) { res.status(500).send('Ошибка генерации акта сверки: ' + err.message); }
    });

    return router;
};