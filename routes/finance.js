const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

module.exports = function (pool, upload) {

    // ==========================================
    // 1. ОТЧЕТ P&L (ПРИБЫЛИ И УБЫТКИ)
    // ==========================================
    // Собирает данные для Дашборда: считает доходы, прямые расходы (сырье, з/п) 
    // и косвенные расходы. Вычисляет валовую и чистую прибыль, а также рентабельность.
    router.get('/api/finance/pnl', async (req, res) => {
        const { start, end } = req.query;
        let params = []; let where = 'WHERE 1=1';

        // Фильтрация по датам, если они переданы
        if (start && end) {
            where += ` AND created_at::date >= $1 AND created_at::date <= $2`;
            params = [start, end];
        }

        try {
            const transRes = await pool.query(`SELECT category, transaction_type, SUM(amount) as total FROM transactions ${where} GROUP BY category, transaction_type`, params);

            let revenue = 0; let directCosts = 0; let indirectCosts = 0;
            const directCategories = ['Закупка сырья', 'Зарплата']; // Основные статьи прямых затрат на производство

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
    // Выводит список будущих платежей (аренда, налоги и т.д.), которые ожидают оплаты
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

    // Оплата планового расхода. Списывает деньги со счета и, если платеж регулярный, 
    // автоматически создает такой же на следующий месяц.
    router.post('/api/finance/planned-expenses/:id/pay', async (req, res) => {
        const { account_id } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const expRes = await client.query("UPDATE planned_expenses SET status = 'paid' WHERE id = $1 RETURNING *", [req.params.id]);
            if (expRes.rows.length === 0) throw new Error('Платеж не найден');
            const exp = expRes.rows[0];

            // Защита от отрицательных сумм
            if (parseFloat(exp.amount) <= 0) throw new Error('Сумма платежа должна быть больше нуля');

            const desc = `Оплата плана: ${exp.category} (${exp.description || ''})`;

            // Фиксируем транзакцию расхода
            await client.query(`
                INSERT INTO transactions (account_id, amount, transaction_type, category, description, transaction_date)
                VALUES ($1, $2, 'expense', $3, $4, NOW())
            `, [account_id, exp.amount, exp.category, desc]);

            // Уменьшаем баланс выбранного расчетного счета
            await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [exp.amount, account_id]);

            // Логика рекуррентных (повторяющихся) платежей
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
    // 3. ТРАНЗАКЦИИ: СПИСОК И МАССОВОЕ УДАЛЕНИЕ
    // ==========================================
    // Главный маршрут получения операций с поддержкой пагинации, поиска и фильтров.
    // Игнорирует транзакции, отправленные в корзину (is_deleted = true).
    router.get('/api/transactions', async (req, res) => {
        const { search, start, end, account_id, page, limit } = req.query;
        const parsedPage = parseInt(page) || 1;
        const parsedLimit = parseInt(limit) || 20;
        const offset = Math.max((parsedPage - 1) * parsedLimit, 0);

        const client = await pool.connect();
        try {
            let conditions = ["COALESCE(t.is_deleted, false) = false"];
            let params = [];
            let paramIndex = 1;

            // Фильтр по тексту (описание, категория или имя контрагента)
            if (search && String(search).trim() !== '') {
                conditions.push(`(t.description ILIKE $${paramIndex} OR t.category ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex})`);
                params.push(`%${String(search).trim()}%`);
                paramIndex++;
            }

            // Фильтр по периоду
            if (start && end) {
                conditions.push(`t.transaction_date >= $${paramIndex}::timestamp AND t.transaction_date <= $${paramIndex + 1}::timestamp + interval '1 day' - interval '1 second'`);
                params.push(start, end);
                paramIndex += 2;
            }

            // Фильтр по конкретному кошельку/счету
            if (account_id && account_id !== 'null' && account_id !== 'undefined') {
                conditions.push(`t.account_id = $${paramIndex}`);
                params.push(parseInt(account_id));
                paramIndex++;
            }

            const whereClause = `WHERE ${conditions.join(' AND ')}`;

            // Считаем общее количество для пагинации
            const countRes = await client.query(`SELECT COUNT(*) FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id ${whereClause}`, params);
            const totalRecords = parseInt(countRes.rows[0].count);

            // Получаем саму страницу данных
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
            const dataRes = await client.query(dataQuery, dataParams);

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
        } finally {
            client.release();
        }
    });

    // Массовое мягкое удаление транзакций с возвратом денег на счета
    router.post('/api/transactions/bulk-delete', async (req, res) => {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Не переданы ID для удаления' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const transRes = await client.query('SELECT id, amount, transaction_type, account_id, description FROM transactions WHERE id = ANY($1::int[])', [ids]);

            for (const trans of transRes.rows) {
                // Откатываем баланс счета
                if (trans.account_id) {
                    const balanceChange = trans.transaction_type === 'income' ? -trans.amount : trans.amount;
                    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, trans.account_id]);
                }

                // Если это была оплата по счету, возвращаем счету статус "неоплачен" (pending)
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
            // Переносим в корзину
            await client.query('UPDATE transactions SET is_deleted = true WHERE id = ANY($1::int[])', [ids]);

            await client.query('COMMIT');
            res.json({ success: true, deletedCount: transRes.rows.length });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: 'Ошибка массового удаления: ' + err.message });
        } finally { client.release(); }
    });

    // ==========================================
    // 4. КАТЕГОРИИ ТРАНЗАКЦИЙ (СПРАВОЧНИК)
    // ==========================================
    // Получение, добавление и удаление пользовательских категорий доходов и расходов.
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

    // Получить список всех контрагентов (для таблицы CRM) с расчетом сальдо
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

    // Полная сводка по конкретному клиенту (для виджетов)
    router.get('/api/counterparties/:id/full', async (req, res) => {
        const cpId = req.params.id;
        const client = await pool.connect();
        try {
            const cpRes = await client.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
            if (cpRes.rows.length === 0) return res.status(404).json({ error: 'Не найден' });

            const finRes = await client.query(`
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
        finally { client.release(); }
    });

    // 🗂️ ПРОФИЛЬ: Загружает всю историю работы с клиентом (операции, счета, договоры)
    router.get('/api/counterparties/:id/profile', async (req, res) => {
        const cpId = req.params.id;
        const client = await pool.connect();
        try {
            const cpRes = await client.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
            if (cpRes.rows.length === 0) return res.status(404).json({ error: 'Контрагент не найден' });

            const transRes = await client.query(`
                SELECT amount, transaction_type, category, description, 
                       TO_CHAR(transaction_date, 'DD.MM.YYYY HH24:MI') as date 
                FROM transactions 
                WHERE counterparty_id = $1 AND COALESCE(is_deleted, false) = false
                ORDER BY transaction_date DESC
            `, [cpId]);

            let invoices = [];
            try {
                const invRes = await client.query(`
                    SELECT id, amount, invoice_number, description, status, 
                           TO_CHAR(created_at, 'DD.MM.YYYY') as date 
                    FROM invoices WHERE counterparty_id = $1 ORDER BY created_at DESC
                `, [cpId]);
                invoices = invRes.rows;
            } catch (e) { }

            let contracts = [];
            try {
                const conRes = await client.query(`
                    SELECT id, number, TO_CHAR(date, 'DD.MM.YYYY') as date 
                    FROM contracts WHERE counterparty_id = $1 ORDER BY date DESC
                `, [cpId]);
                contracts = conRes.rows;
            } catch (e) { }

            res.json({ info: cpRes.rows[0], transactions: transRes.rows, invoices: invoices, contracts: contracts });
        } catch (err) {
            console.error('Ошибка загрузки профиля:', err);
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    // Создание контрагента (Поддержка всех полей от DaData)
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

    // Обновление реквизитов контрагента
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

    // Ввод начальных остатков (Корректировка сальдо)
    router.post('/api/counterparties/:id/correction', async (req, res) => {
        const cpId = req.params.id;
        const { amount, type, date, description } = req.body;
        try {
            await pool.query(`
                INSERT INTO transactions (amount, transaction_type, category, description, payment_method, counterparty_id, transaction_date)
                VALUES ($1, $2, 'Корректировка долга', $3, 'Корректировка', $4, $5)
            `, [amount, type, description || 'Ввод начальных остатков', cpId, date || new Date()]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Удаление контрагента (отвязывает его от транзакций, чтобы не сломать учет)
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

    // Прокси-маршрут для обхода блокировщиков рекламы при запросе к DaData
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

    // Генерация печатной формы Акта сверки
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

    // Получить все выставленные, но еще не оплаченные счета
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

    // Выставить новый счет клиенту (Защита от сумм <= 0)
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

    // Подтверждение ручной оплаты счета: Закрывает счет, создает транзакцию и начисляет НДС
    router.post('/api/invoices/:id/pay', async (req, res) => {
        const { account_id } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const invRes = await client.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
            const inv = invRes.rows[0];
            if (!inv) throw new Error('Счет не найден');
            if (parseFloat(inv.amount) <= 0) throw new Error('Критическая ошибка: сумма счета меньше или равна нулю!');

            // 1. Помечаем счет как оплаченный
            await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [req.params.id]);

            // 2. Расчет актуального НДС 22% по формуле (amount * 22) / 122
            const vatAmount = (inv.amount * 22) / 122;
            const desc = `Оплата по счету №${inv.invoice_number}. ${inv.description || ''}`;

            // 3. Создаем приходную операцию с привязкой текущей даты
            await client.query(`
                INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, transaction_date)
                VALUES ($1, 'income', 'Продажа продукции', $2, $3, 'Безналичный расчет', $4, $5, NOW())
            `, [inv.amount, desc, vatAmount, account_id, inv.counterparty_id]);

            // 4. Пополняем фактический баланс расчетного счета
            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [inv.amount, account_id]);

            await client.query('COMMIT');
            res.json({ success: true, message: 'Счет успешно оплачен' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: err.message });
        } finally { client.release(); }
    });

    // Удаление ошибочно выставленного счета
    router.delete('/api/invoices/:id', async (req, res) => {
        try {
            await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
            res.json({ success: true, message: 'Счет удален' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ==========================================
    // 7. СЧЕТА КОМПАНИИ, ПЕРЕВОДЫ И СОЗДАНИЕ ТРАНЗАКЦИЙ
    // ==========================================

    // График распределения финансов по категориям за период
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

    // Получить список всех кошельков/расчетных счетов бизнеса
    router.get('/api/accounts', async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM accounts ORDER BY id ASC');
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Создать новый кошелек/счет
    router.post('/api/accounts', async (req, res) => {
        const { name, type, balance } = req.body;
        try {
            await pool.query('INSERT INTO accounts (name, type, balance) VALUES ($1, $2, $3)', [name, type, balance || 0]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Ручное создание одиночной транзакции с пересчетом баланса банка
    router.post('/api/transactions', async (req, res) => {
        const { amount, type, category, description, method, account_id, counterparty_id } = req.body;
        if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) {
            return res.status(400).json({ error: 'Сумма операции должна быть больше нуля!' });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`
                INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, transaction_date)
                VALUES ($1, $2, $3, $4, 0, $5, $6, $7, NOW())
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

    // Внутренний перевод между своими счетами (например: Касса -> Расчетный счет)
    router.post('/api/transactions/transfer', async (req, res) => {
        const { from_id, to_id, amount, description } = req.body;
        if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Сумма перевода должна быть больше нуля!' });
        if (String(from_id) === String(to_id)) return res.status(400).json({ error: 'Нельзя перевести деньги на тот же счет!' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const comment = `Внутренний перевод: ${description}`;

            await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, from_id]);
            await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id, transaction_date) VALUES ($1, 'expense', 'Перевод', $2, $3, NOW())`, [amount, comment, from_id]);

            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, to_id]);
            await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id, transaction_date) VALUES ($1, 'income', 'Перевод', $2, $3, NOW())`, [amount, comment, to_id]);

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

    // Одиночное мягкое удаление операции в корзину с возвратом денег на счет
    router.delete('/api/transactions/:id', async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const trRes = await client.query('SELECT amount, transaction_type, account_id FROM transactions WHERE id = $1', [req.params.id]);
            if (trRes.rows.length === 0) throw new Error('Операция не найдена');
            const tr = trRes.rows[0];

            await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [req.params.id]);

            const balanceChange = tr.transaction_type === 'income' ? -tr.amount : tr.amount;
            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, tr.account_id]);

            await client.query('COMMIT');
            res.json({ success: true, message: 'Операция перемещена в корзину' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    // Редактирование существующей операции (сумма, категория, дата)
    router.put('/api/transactions/:id', async (req, res) => {
        const { description, amount, category, account_id, counterparty_id, transaction_date } = req.body;
        try {
            await pool.query(`
                UPDATE transactions 
                SET description=$1, amount=$2, category=$3, account_id=$4, counterparty_id=$5, 
                    transaction_date=COALESCE($6, transaction_date)
                WHERE id=$7
            `, [description, amount, category, account_id || null, counterparty_id || null, transaction_date || null, req.params.id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // УМНЫЙ ИМПОРТ ИЗ 1С: Пакетная загрузка выписок из банка.
    // Умеет сам находить или создавать контрагентов по ИНН, защищен от дублей.
    router.post('/api/transactions/import', async (req, res) => {
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

                // Поиск или автосоздание контрагента
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

                // Защита от дублей: проверяем по сумме, описанию и точной дате
                const dupCheck = await client.query(`
                    SELECT id FROM transactions 
                    WHERE account_id = $1 AND amount = $2 AND description = $3 AND transaction_type = $4 
                    AND (created_at::date = $5::date OR transaction_date::date = $5::date)
                    LIMIT 1
                `, [account_id, tr.amount, tr.description, tr.type, txDate]);

                if (dupCheck.rows.length === 0) {
                    let category = tr.type === 'income' ? 'Продажа продукции' : 'Закупка сырья';
                    const desc = (tr.description || '').toLowerCase();
                    const cpName = (tr.counterparty_name || '').toLowerCase();

                    // Авто-распределение по категориям на основе ключевых слов в назначении платежа
                    if (tr.type === 'expense') {
                        if (cpName.includes('уфк') || cpName.includes('казначейство') || desc.includes('налог') || desc.includes('взыскан') || desc.includes('пфр')) category = 'Налоги, штрафы и взносы';
                        else if (desc.includes('комисс') || cpName.includes('банк') || desc.includes('рко')) category = 'Услуги банка и РКО';
                        else if (desc.includes('аренд')) category = 'Аренда помещений';
                        else if (desc.includes('займ') || desc.includes('заем') || desc.includes('кредит')) category = 'Возврат займов';
                        else if (desc.includes('зарплат') || desc.includes('оплат труда') || desc.includes('аванс') || desc.includes('ндфл')) category = 'Зарплата';
                        else if (desc.includes('материал') || desc.includes('сырь') || desc.includes('цемент') || desc.includes('песок') || desc.includes('щебень')) category = 'Закупка сырья';
                        else if (desc.includes('доставк') || desc.includes('транспорт') || desc.includes('логист')) category = 'Транспортные расходы';
                    } else if (tr.type === 'income') {
                        if (desc.includes('займ') || desc.includes('заем') || desc.includes('кредит')) category = 'Получение займов';
                        else if (desc.includes('возврат')) category = 'Возврат средств';
                    }

                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date, created_at) 
                        VALUES ($1, $2, $3, $4, 'Безналичный расчет (Импорт)', $5, $6, $7::timestamp, $7::timestamp)
                    `, [tr.amount, tr.type, category, tr.description, account_id, cp_id, txDate]);

                    const balanceChange = tr.type === 'income' ? tr.amount : -tr.amount;
                    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, account_id]);

                    // Интеллектуальное авто-гашение счетов, если в назначении есть "СЧ-123"
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

    // ==========================================
    // 9. ФАЙЛЫ, ЧЕКИ И АНАЛИТИКА СЕБЕСТОИМОСТИ
    // ==========================================

    // Загрузка фото/PDF чека к конкретной транзакции
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

    // Удаление файла чека с диска и из базы
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

    // Аналитика рентабельности отгрузок (Юнит-экономика)
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
    // 10. ПРЕДСКАЗАНИЕ КАССОВЫХ РАЗРЫВОВ (ПРОГНОЗ)
    // ==========================================
    // Анализирует текущий баланс, ожидаемые доходы (счета) и плановые расходы.
    // Строит финансовую модель на 30 дней вперед и ищет отрицательный баланс.
    router.get('/api/finance/cashflow-forecast', async (req, res) => {
        const client = await pool.connect();
        try {
            // 1. Считаем текущий реальный капитал (суммируем балансы всех кошельков)
            const accRes = await client.query('SELECT SUM(balance) as total_balance FROM accounts');
            let currentBalance = parseFloat(accRes.rows[0].total_balance) || 0;

            // 2. Достаем дебиторскую задолженность (Счета, которые нам еще не оплатили)
            // Даем клиентам условные 3 дня на оплату с момента выставления счета
            const invRes = await client.query(`
                SELECT amount, created_at::date + integer '3' as expected_date 
                FROM invoices WHERE status = 'pending'
            `);

            // 3. Достаем кредиторскую задолженность (Наши плановые расходы: аренда, налоги)
            const expRes = await client.query(`
                SELECT amount, date as expected_date 
                FROM planned_expenses WHERE status = 'pending'
            `);

            // 4. Запускаем машину времени: строим прогноз на 30 дней вперед
            const forecast = [];
            let runningBalance = currentBalance;
            const today = new Date();
            // Сбрасываем время, чтобы корректно сравнивать даты
            today.setHours(0, 0, 0, 0);

            // Цикл проходит по каждому из следующих 30 дней
            for (let i = 0; i <= 30; i++) {
                const targetDate = new Date(today);
                targetDate.setDate(today.getDate() + i);
                const dateStr = targetDate.toISOString().split('T')[0];

                let dailyIncome = 0;
                let dailyExpense = 0;

                // Проверяем, есть ли ожидаемые доходы в этот день
                invRes.rows.forEach(inv => {
                    const invDateObj = new Date(inv.expected_date);
                    // Если счет просрочен (дата в прошлом), считаем, что ждем деньги прямо СЕГОДНЯ (i === 0)
                    const invDate = invDateObj < today ? today.toISOString().split('T')[0] : invDateObj.toISOString().split('T')[0];
                    if (invDate === dateStr) dailyIncome += parseFloat(inv.amount);
                });

                // Проверяем, есть ли плановые платежи в этот день
                expRes.rows.forEach(exp => {
                    const expDateObj = new Date(exp.expected_date);
                    // Если мы забыли оплатить план в прошлом, он падает на СЕГОДНЯ
                    const expDate = expDateObj < today ? today.toISOString().split('T')[0] : expDateObj.toISOString().split('T')[0];
                    if (expDate === dateStr) dailyExpense += parseFloat(exp.amount);
                });

                // Пересчитываем виртуальный баланс на конец этого дня
                runningBalance = runningBalance + dailyIncome - dailyExpense;

                // Сохраняем слепок дня в массив прогноза
                forecast.push({
                    date: dateStr,
                    income: dailyIncome,
                    expense: dailyExpense,
                    projected_balance: runningBalance
                });
            }

            // Отправляем готовый прогноз в браузер
            res.json({ currentBalance, forecast });
        } catch (err) {
            console.error('Ошибка прогноза кассовых разрывов:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // ==========================================
    // 11. ПРОДВИНУТАЯ НАЛОГОВАЯ КОПИЛКА (УРОВЕНЬ ERP)
    // ==========================================
    router.get('/api/finance/tax-piggy-bank', async (req, res) => {
        // Добавили usn_rate для гибкой настройки процента
        const { start, end, usn_rate } = req.query;
        const usnRate = usn_rate ? parseFloat(usn_rate) : 3;
        const usnMultiplier = usnRate / 100;

        let params = [];
        let where = "WHERE COALESCE(t.is_deleted, false) = false ";
        where += "AND t.category NOT IN ('Перевод', 'Корректировка долга', 'Ввод остатков') ";

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

                // Переводим описание в нижний регистр для надежного поиска
                const descLower = (t.description || '').toLowerCase();

                // Операция признается "Без НДС", если это спец-категория ИЛИ в тексте прямо написано "без ндс"
                t.is_no_vat = noVatCategories.includes(t.category) || descLower.includes('без ндс');

                if (t.account_type === 'cash') {
                    // ЛОГИКА КАССЫ (Гибкая ставка УСН)
                    if (t.transaction_type === 'income') {
                        const tax = amt * usnMultiplier;
                        t.calculated_tax = tax;
                        cashData.turnover += amt; // Считаем общую базу доходов
                        cashData.totalTax += tax;
                        cashData.transactions.push(t);
                    } else {
                        t.calculated_tax = 0;
                        cashData.transactions.push(t);
                    }
                } else {
                    // ЛОГИКА БАНКА (НДС 22%)
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
    // Переключатель галочек (Исключить / Принудительный НДС)
    router.post('/api/finance/tax-status', async (req, res) => {
        const { id, field, is_checked } = req.body;
        try {
            // field может быть 'tax_excluded' или 'tax_force_vat'
            await pool.query(`UPDATE transactions SET ${field} = $1 WHERE id = $2`, [is_checked, id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Сохранение глобальных настроек (Ставка УСН, корректировки)
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

    // Маршрут для получения глобальных настроек при загрузке
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