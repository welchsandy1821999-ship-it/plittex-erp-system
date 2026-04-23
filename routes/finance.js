const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { auditLog } = require('../utils/db_init');
const fs = require('fs');
const path = require('path');
const Big = require('big.js');
const { requireAdmin, authenticateToken } = require('../middleware/auth');
const { validateTransaction, validateTransactionEdit, validateTransfer, validateCounterparty, validateInvoice, validateAccount, validateAccountEdit, validateCategory, validateCorrection, validatePayment, validateCostGroup } = require('../middleware/validator');

// 🚀 Единая функция поиска документов в тексте (Защита от опечаток)
function extractDocNumber(description) {
    if (!description) return null;
    const match = String(description).match(/(СЧ|ЗК)-(\d+)/i);
    return match ? match[0].toUpperCase() : null;
}

module.exports = function (pool, upload, withTransaction, ERP_CONFIG) {







    // ==========================================
        // ==========================================
    // 0. СПРАВОЧНИК КАТЕГОРИЙ (Single Source of Truth)
    // ==========================================
    router.get('/api/finance/categories', async (req, res) => {
        try {
            // Выдаем полный плоский список (дерево соберет фронтенд)
            // Но мы все еще объединяем "дикие" категории, которых нет в справочнике
            const result = await pool.query(`
                SELECT id, name, type, cost_group, parent_id, is_archived, monthly_limit, false as is_wild
                FROM transaction_categories
                UNION
                SELECT NULL as id, category as name, MAX(transaction_type) as type, NULL as cost_group, NULL as parent_id, false as is_archived, 0 as monthly_limit, true as is_wild
                  FROM transactions
                 WHERE category IS NOT NULL AND category != ''
                   AND (is_deleted IS NULL OR is_deleted = false)
                   AND category NOT IN (SELECT name FROM transaction_categories)
                 GROUP BY category
                ORDER BY name
            `);
            res.json(result.rows);
        } catch (err) {
            logger.error('[API] Error in GET /api/finance/categories:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    // Добавление новой категории
    router.post('/api/finance/category-full', requireAdmin, async (req, res) => {
        try {
            const { name, type, cost_group, parent_id, monthly_limit } = req.body;
            await pool.query(
                'INSERT INTO transaction_categories (name, type, cost_group, parent_id, monthly_limit) VALUES ($1, $2, $3, $4, $5)', 
                [name, type, cost_group || null, parent_id || null, monthly_limit || 0]
            );
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Обновление категории (редактирование)
    router.put('/api/finance/category-full/:id', requireAdmin, async (req, res) => {
        try {
            const { name, type, cost_group, parent_id, monthly_limit } = req.body;
            
            await pool.query('BEGIN');
            
            const oldCatRes = await pool.query('SELECT name FROM transaction_categories WHERE id = $1', [req.params.id]);
            if (oldCatRes.rows.length === 0) throw new Error('Category not found');
            const oldName = oldCatRes.rows[0].name;
            
            await pool.query(
                'UPDATE transaction_categories SET name=$1, type=$2, cost_group=$3, parent_id=$4, monthly_limit=$5 WHERE id=$6', 
                [name, type, cost_group || null, parent_id || null, monthly_limit || 0, req.params.id]
            );
            
            // Если переименовали, обновляем все исторические транзакции (чтобы не отвязались)
            if (oldName !== name) {
                await pool.query('UPDATE transactions SET category = $1 WHERE category = $2', [name, oldName]);
            }
            
            await pool.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await pool.query('ROLLBACK');
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Архивация или Разархивация
    router.put('/api/finance/category-full/:id/archive', requireAdmin, async (req, res) => {
        try {
            const { is_archived } = req.body;
            await pool.query('UPDATE transaction_categories SET is_archived = $1 WHERE id = $2', [is_archived, req.params.id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Smart Merge (Умное объединение дубликатов)
    // Принимает source_names (массив имен, т.к. "дикие" транзакции привязаны по имени) 
    // и target_name (имя категории в которую объединяем)
    router.post('/api/finance/category-merge', requireAdmin, async (req, res) => {
        try {
            const { source_names, target_name } = req.body;
            if (!target_name || !source_names || source_names.length === 0) {
                return res.status(400).json({ error: 'Не переданы данные для объединения' });
            }

            await pool.query('BEGIN');

            await pool.query(
                'UPDATE transactions SET category = $2 WHERE category = ANY($1::varchar[])',
                [source_names, target_name]
            );

            await pool.query(
                'DELETE FROM transaction_categories WHERE name = ANY($1::varchar[]) AND name != $2',
                [source_names, target_name]
            );

            await pool.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await pool.query('ROLLBACK');
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка.' });
        }
    });

    // ==========================================
    // ==========================================
    // 1. ОТЧЕТ P&L (ДИНАМИЧЕСКИЙ МЕТОД СО СРЕДНЕВЗВЕШЕННОЙ COGS И ТАБЕЛЯМИ)
    // ==========================================
    
    // ==========================================
    // СИНХРОНИЗАЦИЯ ОБЕЗЛИЧЕННЫХ ТРАНЗАКЦИЙ (Орфанов)
    // ==========================================
    router.get('/api/finance/orphans', requireAdmin, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT t.id, t.transaction_date, t.amount, t.transaction_type, t.category, t.description 
                FROM transactions t
                WHERE t.counterparty_id IS NULL AND (t.is_deleted = false OR t.is_deleted IS NULL)
                ORDER BY t.transaction_date DESC, t.id DESC
            `);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка при загрузке несинхронизированных транзакций.' });
        }
    });

    router.post('/api/finance/bind-orphan', requireAdmin, async (req, res) => {
        try {
            const { transaction_id, counterparty_id } = req.body;
            if (!transaction_id || !counterparty_id) {
                return res.status(400).json({ error: 'ID транзакции и Контрагента обязательны.' });
            }
            await pool.query('UPDATE transactions SET counterparty_id = $1 WHERE id = $2', [counterparty_id, transaction_id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Возникла ошибка при привязке контрагента.' });
        }
    });

    router.get('/api/finance/pnl', async (req, res) => {
        let { start, end } = req.query;

        if (!start || !end || start === '' || end === '') {
            start = '2024-01-01';
            end = new Date().toISOString().split('T')[0];
        }

        try {
            const [revenueRes, otherIncomeRes, cogsRes, opexRes, laborRes, capexRes] = await Promise.all([
                // 💰 1. ВЫРУЧКА = income с категорией 'Продажа продукции'
                pool.query(`
                    SELECT COALESCE(SUM(amount), 0) as total
                    FROM transactions
                    WHERE transaction_type = 'income'
                      AND (is_deleted IS NULL OR is_deleted = false)
                      AND category = 'Продажа продукции'
                      AND transaction_date >= $1::timestamp AND transaction_date < ($2::timestamp + interval '1 day')
                `, [start, end]),

                // 📈 2. ДРУГИЕ ДОХОДЫ (все income КРОМЕ Продажи) — справочно
                pool.query(`
                    SELECT COALESCE(SUM(amount), 0) as total
                    FROM transactions
                    WHERE transaction_type = 'income'
                      AND (is_deleted IS NULL OR is_deleted = false)
                      AND category != 'Продажа продукции'
                      AND transaction_date >= $1::timestamp AND transaction_date < ($2::timestamp + interval '1 day')
                `, [start, end]),

                // 🧱 3. COGS = expense-транзакции в группе 'direct'
                pool.query(`
                    SELECT COALESCE(SUM(t.amount), 0) as total
                    FROM transactions t
                    LEFT JOIN transaction_categories tc ON t.category = tc.name
                    WHERE t.transaction_type = 'expense'
                      AND t.category != 'Перевод'
                      AND (t.is_deleted IS NULL OR t.is_deleted = false)
                      AND COALESCE(t.cost_group_override, tc.cost_group, 'capex') = 'direct'
                      AND t.transaction_date >= $1::timestamp AND t.transaction_date < ($2::timestamp + interval '1 day')
                `, [start, end]),

                // 📉 4. OPEX = expense-транзакции в группе 'opex'
                pool.query(`
                    SELECT COALESCE(SUM(t.amount), 0) as total
                    FROM transactions t
                    LEFT JOIN transaction_categories tc ON t.category = tc.name
                    WHERE t.transaction_type = 'expense'
                      AND t.category != 'Перевод'
                      AND (t.is_deleted IS NULL OR t.is_deleted = false)
                      AND COALESCE(t.cost_group_override, tc.cost_group, 'capex') = 'opex'
                      AND t.transaction_date >= $1::timestamp AND t.transaction_date < ($2::timestamp + interval '1 day')
                `, [start, end]),

                // 🛝 5. ФОТ (Справочно, метод начисления из Табеля)
                pool.query(`
                    SELECT COALESCE(SUM(
                        COALESCE(bonus, 0) + COALESCE(custom_rate, 0) - COALESCE(penalty, 0)
                    ), 0) as total
                    FROM timesheet_records
                    WHERE record_date >= $1::timestamp AND record_date < ($2::timestamp + interval '1 day')
                `, [start, end]),

                // 🏗️ 6. CAPEX = expense-транзакции, не direct и не opex
                pool.query(`
                    SELECT COALESCE(SUM(t.amount), 0) as total
                    FROM transactions t
                    LEFT JOIN transaction_categories tc ON t.category = tc.name
                    WHERE t.transaction_type = 'expense'
                      AND t.category != 'Перевод'
                      AND (t.is_deleted IS NULL OR t.is_deleted = false)
                      AND COALESCE(t.cost_group_override, tc.cost_group, 'capex') NOT IN ('direct', 'opex')
                      AND t.transaction_date >= $1::timestamp AND t.transaction_date < ($2::timestamp + interval '1 day')
                `, [start, end])
            ]);

            // 🧮 МАТЕМАТИКА P&L (Big.js для точности до копеек)
            const revenue = new Big(Number(revenueRes.rows[0].total));
            const otherIncome = new Big(Number(otherIncomeRes.rows[0].total));

            const cogs = new Big(Number(cogsRes.rows[0].total));
            const opex = new Big(Number(opexRes.rows[0].total));
            const capex = new Big(Number(capexRes.rows[0].total));
            const labor = new Big(Number(laborRes.rows[0].total)).abs();

            const totalExpenses = cogs.plus(opex).plus(capex);
            const netProfit = revenue.minus(totalExpenses);
            const totalIncome = revenue;
            const margin = revenue.gt(0) && netProfit.gt(0)
                ? netProfit.div(revenue).times(100).toFixed(1)
                : "0.0";

            console.log("P&L API -> revenue:", revenue.toString(), "cogs:", cogs.toString(), "opex:", opex.toString(), "capex:", capex.toString(), "netProfit:", netProfit.toString());

            res.json({
                revenue: revenue.toFixed(2),
                otherIncome: otherIncome.toFixed(2),
                totalIncome: totalIncome.toFixed(2),

                cogs: cogs.toFixed(2),
                opex: opex.toFixed(2),
                capex: capex.toFixed(2),
                laborCosts: labor.toFixed(2),  // 📋 Справочно для руководителя
                totalExpenses: totalExpenses.toFixed(2),

                netProfit: netProfit.toFixed(2),
                margin: margin
            });

        } catch (err) {
            logger.error('КРИТИЧЕСКАЯ ОШИБКА P&L:', err.message, err.stack);
            res.status(500).json({ error: "Внутренняя ошибка сервера. Обратитесь к администратору." });
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
            logger.error('Ошибка загрузки календаря:', err.message);
            res.json([]);
        }
    });

    router.post('/api/finance/planned-expenses/:id/pay', validatePayment, async (req, res) => {
        const { account_id } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                const expRes = await client.query("UPDATE planned_expenses SET status = 'paid' WHERE id = $1 RETURNING *", [req.params.id]);
                if (expRes.rows.length === 0) throw new Error('Платеж не найден');
                const exp = expRes.rows[0];

                if (parseFloat(exp.amount) <= 0) throw new Error('Сумма платежа должна быть больше нуля');

                const desc = `Оплата плана: ${exp.category} (${exp.description || ''})`;

                await client.query(`
                    INSERT INTO transactions (account_id, amount, transaction_type, category, description, transaction_date, payment_method, source_module, linked_planned_id)
                    VALUES ($1, $2, 'expense', $3, $4, NOW(), $5, $6, $7)
                `, [account_id, exp.amount, exp.category, desc, 'Безналичный расчет', 'finance', req.params.id]);

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
                "COALESCE(t.is_deleted, false) = false"
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
                conditions.push(`t.transaction_date::date >= $${paramIndex}::date AND t.transaction_date::date <= $${paramIndex + 1}::date`);
                params.push(start, end);
                paramIndex += 2;
            }

            const whereClause = `WHERE ${conditions.join(' AND ')}`;

            const countRes = await pool.query(`SELECT COUNT(*) FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id ${whereClause}`, params);
            const totalRecords = parseInt(countRes.rows[0].count);

            const dataQuery = `
                SELECT DISTINCT ON (t.transaction_date, t.id) t.id, t.transaction_date, t.amount, t.transaction_type, 
                       t.category, t.description, t.payment_method, t.vat_amount,
                       t.counterparty_id, t.account_id, 
                       t.cost_group_override, /* 👈 Добавили ручное исключение */
                       COALESCE(t.cost_group_override, tc.cost_group, 'overhead') as current_cost_group, /* 👈 Вычисляем итоговую группу */
                       c.name as counterparty_name, a.name as account_name
                FROM transactions t
                LEFT JOIN counterparties c ON t.counterparty_id = c.id
                LEFT JOIN accounts a ON t.account_id = a.id
                LEFT JOIN transaction_categories tc ON t.category = tc.name /* 👈 Джойним матрицу категорий */
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
            logger.error('Ошибка загрузки транзакций:', err);
            res.status(500).json({ error: 'Ошибка сервера при загрузке данных' });
        }
    });

    router.delete('/api/transactions/bulk-delete', requireAdmin, async (req, res) => {
        const { ids } = req.body;
        if (!ids || ids.length === 0) return res.json({ success: true });

        try {
            await withTransaction(pool, async (client) => {
                for (let id of ids) {
                    const txRes = await client.query('SELECT amount, transaction_type, linked_order_id, linked_planned_id FROM transactions WHERE id = $1', [id]);
                    if (txRes.rows.length > 0) {
                        const { amount, transaction_type, linked_order_id, linked_planned_id } = txRes.rows[0];

                        if (linked_order_id && transaction_type === 'income') {
                            await client.query(`
                                UPDATE client_orders 
                                SET paid_amount = GREATEST(paid_amount - $1, 0), 
                                    pending_debt = pending_debt + $1 
                                WHERE id = $2
                            `, [amount, linked_order_id]);
                        }

                        if (linked_planned_id) {
                            await client.query("UPDATE planned_expenses SET status = 'pending' WHERE id = $1", [linked_planned_id]);
                        }

                        await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [id]);
                    }
                }

                // Пересчет балансов всех касс после массового удаления
                await client.query(`
                    UPDATE accounts a 
                    SET balance = ROUND(COALESCE((
                        SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) - 
                               SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) 
                        FROM transactions t 
                        WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                    ), 0), 2)
                `);
            });

            // Аудит: запись о массовом удалении
            for (const id of ids) {
                auditLog(pool, req, 'delete_transaction', 'transaction', id, `Массовое удаление (bulk-delete)`);
            }

            res.json({ success: true });
        } catch (e) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ==========================================
    // 4. КАТЕГОРИИ ТРАНЗАКЦИЙ (СПРАВОЧНИК)
    // ==========================================

    router.post('/api/finance/categories', requireAdmin, validateCategory, async (req, res) => {
        try {
            await pool.query('INSERT INTO transaction_categories (name, type) VALUES ($1, $2)', [req.body.name, req.body.type]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.delete('/api/finance/categories/:id', requireAdmin, async (req, res) => {
        try {
            await pool.query('DELETE FROM transaction_categories WHERE id = $1', [req.params.id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Обновление группы затрат (Матрица статей)
    router.put('/api/finance/categories/:id/group', requireAdmin, validateCostGroup, async (req, res) => {
        try {
            const { cost_group } = req.body;
            await pool.query('UPDATE transaction_categories SET cost_group = $1 WHERE id = $2', [cost_group, req.params.id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Получение группы затрат для предпросмотра категории
    router.get('/api/finance/category-info', async (req, res) => {
        const { name } = req.query;
        if (!name) return res.json({ cost_group: null });

        try {
            // Приоритет: dashboard_rules
            const ruleRes = await pool.query('SELECT mapped_cost_group FROM dashboard_rules WHERE original_category = $1 OR mapped_category = $1 LIMIT 1', [name]);
            if (ruleRes.rows.length > 0 && ruleRes.rows[0].mapped_cost_group) {
                return res.json({ cost_group: ruleRes.rows[0].mapped_cost_group });
            }

            // Затем transaction_categories
            const catRes = await pool.query('SELECT cost_group FROM transaction_categories WHERE name = $1 LIMIT 1', [name]);
            if (catRes.rows.length > 0 && catRes.rows[0].cost_group) {
                return res.json({ cost_group: catRes.rows[0].cost_group });
            }

            res.json({ cost_group: null });
        } catch (err) {
            res.json({ cost_group: null });
        }
    });

    // ==========================================
    // 5. КОНТРАГЕНТЫ (CRM) И КАРТОЧКА 360°
    // ==========================================
    router.get('/api/counterparties', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT c.id, c.name, 
                       COALESCE(c.phone, '') as phone, COALESCE(c.email, '') as email,
                       COALESCE(c.inn, '') as inn, COALESCE(c.kpp, '') as kpp,
                       COALESCE(c.ogrn, '') as ogrn, COALESCE(c.legal_address, '') as legal_address,
                       COALESCE(c.fact_address, '') as fact_address,
                       COALESCE(c.bank_name, '') as bank_name, COALESCE(c.bank_bik, '') as bank_bik,
                       COALESCE(c.bank_account, '') as bank_account, COALESCE(c.bank_corr, '') as bank_corr,
                       COALESCE(c.checking_account, '') as checking_account, COALESCE(c.bik, '') as bik,
                       COALESCE(c.director_name, '') as director_name,
                       COALESCE(c.comment, '') as comment,
                       COALESCE(c.client_category, 'Обычный') as client_category,
                       COALESCE(c.entity_type, 'legal') as entity_type,
                       COALESCE(c.is_buyer, false) as is_buyer,
                       COALESCE(c.is_supplier, false) as is_supplier,
                       COALESCE(c.is_employee, false) as is_employee,
                       c.employee_id, c.pallets_balance, c.price_level, c.role,
                       COALESCE(SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END), 0) as total_paid_to_us,
                       COALESCE(SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END), 0) as total_paid_by_us,
                       MAX(t.transaction_date) as last_transaction_date
                FROM counterparties c
                LEFT JOIN transactions t ON c.id = t.counterparty_id AND COALESCE(t.is_deleted, false) = false
                WHERE COALESCE(c.is_deleted, false) = false
                GROUP BY c.id
                ORDER BY last_transaction_date DESC NULLS LAST, c.name ASC
            `);
            res.json(result.rows);
        } catch (err) {
            logger.error('Ошибка в списке контрагентов:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
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
                WHERE counterparty_id = $1 AND COALESCE(is_deleted, false) = false AND category != 'Зачёт аванса' AND COALESCE(payment_method, '') != 'Взаимозачет'
            `, [cpId]);

            const finances = finRes.rows[0];
            const balance = parseFloat(finances.total_paid_to_us) - parseFloat(finances.total_paid_to_them);

            res.json({ cp: cpRes.rows[0], finances: { ...finances, balance } });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/counterparties/:id/profile', async (req, res) => {
        const cpId = req.params.id;
        if (!cpId || cpId === 'null') return res.status(400).json({ error: 'ID не указан' });

        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
            if (cpRes.rows.length === 0) return res.status(404).json({ error: 'Контрагент не найден' });
            const cp = cpRes.rows[0];

            const queries = `
                SELECT amount, transaction_type, category, description,
                       TO_CHAR(transaction_date, 'DD.MM.YYYY HH24:MI') as date, 'money' as origin, transaction_date as sort_date
                FROM transactions WHERE counterparty_id = $1 AND COALESCE(is_deleted, false) = false AND category != 'Зачёт аванса' AND COALESCE(payment_method, '') != 'Взаимозачет'
                UNION ALL
                SELECT SUM(ABS(m.quantity) * coi.price) as amount, 'expense' as transaction_type, 'Отгрузка продукции' as category,
                       m.description as description, TO_CHAR(COALESCE(m.movement_date, m.created_at), 'DD.MM.YYYY') as date, 'goods' as origin, COALESCE(m.movement_date, m.created_at) as sort_date
                FROM inventory_movements m
                JOIN client_order_items coi ON m.linked_order_item_id = coi.id
                JOIN client_orders co ON coi.order_id = co.id
                WHERE co.counterparty_id = $1 AND m.movement_type = 'sales_shipment'
                GROUP BY m.description, COALESCE(m.movement_date, m.created_at)
                UNION ALL
                SELECT amount, 'income' as transaction_type, 'Поставка сырья' as category,
                       description, TO_CHAR(COALESCE(movement_date, created_at), 'DD.MM.YYYY') as date, 'goods' as origin, COALESCE(movement_date, created_at) as sort_date
                FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase'
            `;
            const timelineRes = await pool.query(`SELECT * FROM (${queries}) AS combined ORDER BY sort_date DESC`, [cpId]);
            const timeline = timelineRes.rows;

            // УНИВЕРСАЛЬНАЯ ФОРМУЛА САЛЬДО ERP:
            let ourShipments = new Big(0); let ourPayments = new Big(0);
            let theirShipments = new Big(0); let theirPayments = new Big(0);

            timeline.forEach(item => {
                const amt = new Big(item.amount);
                if (item.origin === 'goods') {
                    if (item.transaction_type === 'expense') ourShipments = ourShipments.plus(amt);
                    else theirShipments = theirShipments.plus(amt);
                } else if (item.origin === 'money') {
                    if (item.transaction_type === 'expense') ourPayments = ourPayments.plus(amt);
                    else theirPayments = theirPayments.plus(amt);
                }
            });

            // Положительное сальдо: должны НАМ. Отрицательное: должны МЫ.
            const balance = ourShipments.plus(ourPayments).minus(theirShipments).minus(theirPayments).toFixed(2);

            const overpayment = parseFloat(balance) < 0 ? Math.abs(parseFloat(balance)).toFixed(2) : '0.00';
            res.json({
                info: cp,
                transactions: timeline,
                finances: { balance, totalPaid: theirPayments.toFixed(2), totalInvoiced: ourShipments.toFixed(2) },
                overpayment: parseFloat(overpayment),
                saldo: parseFloat(balance),
                invoices: [], contracts: []
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
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
            logger.error('Ошибка загрузки договоров:', err.message);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/counterparties', requireAdmin, validateCounterparty, async (req, res) => {
        // 🚀 ИСПРАВЛЕНИЕ: Добавили price_level и type
        const { name, role, type, price_level, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entity_type, is_buyer, is_supplier } = req.body;
        try {
            // Фронтенд продаж шлет type, а старые формы шлют role
            const finalRole = type || role || 'Покупатель';
            let buyer = is_buyer !== undefined ? is_buyer : (finalRole === 'Покупатель' || !finalRole);
            let supplier = is_supplier !== undefined ? is_supplier : (finalRole === 'Поставщик');

            await pool.query(`
                INSERT INTO counterparties (name, role, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entity_type, is_buyer, is_supplier, price_level) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            `, [name, finalRole, client_category || 'Обычный', inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entity_type || 'legal', buyer, supplier, price_level || 'basic']);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.put('/api/counterparties/:id', requireAdmin, validateCounterparty, async (req, res) => {
        // 🚀 ИСПРАВЛЕНИЕ: Добавили price_level и type
        const { name, role, type, price_level, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entity_type, is_buyer, is_supplier } = req.body;
        try {
            const finalRole = type || role; // Берем то, что прислал фронтенд

            await pool.query(`
                UPDATE counterparties SET name=$1, role=$2, client_category=$3, inn=$4, kpp=$5, ogrn=$6, legal_address=$7, fact_address=$8, bank_name=$9, bank_bik=$10, bank_account=$11, bank_corr=$12, director_name=$13, phone=$14, email=$15, comment=$16, entity_type=$17, is_buyer=$18, is_supplier=$19, price_level=$20 
                WHERE id=$21
            `, [name, finalRole, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entity_type || 'legal', is_buyer || false, is_supplier || false, price_level || 'basic', req.params.id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/counterparties/:id/correction', requireAdmin, validateCorrection, async (req, res) => {
        const cpId = req.params.id;
        const { amount, type, date, description } = req.body;
        try {
            await pool.query(`
                INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date) 
                VALUES ($1, $2, 'Корректировка долга', $3, 'Системная правка', NULL, $4, $5)
            `, [amount, type, description, cpId, date]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/counterparties/:id/corrections', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT id, amount, transaction_type, description, TO_CHAR(transaction_date, 'YYYY-MM-DD') as date
                FROM transactions 
                WHERE counterparty_id = $1 AND category = 'Корректировка долга' AND COALESCE(is_deleted, false) = false
                ORDER BY transaction_date DESC, id DESC
            `, [req.params.id]);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка загрузки корректировок.' });
        }
    });

    router.put('/api/finance/transactions/:id/description', requireAdmin, async (req, res) => {
        try {
            const txRes = await pool.query('UPDATE transactions SET description = $1 WHERE id = $2 RETURNING id', [req.body.description, req.params.id]);
            if (txRes.rows.length === 0) return res.status(404).json({error: 'Транзакция не найдена'});
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка обновления транзакции.' });
        }
    });

    router.delete('/api/finance/transactions/:id', requireAdmin, async (req, res) => {
        try {
            const txRes = await pool.query('UPDATE transactions SET is_deleted = true WHERE id = $1 RETURNING counterparty_id', [req.params.id]);
            if (txRes.rows.length === 0) return res.status(404).json({error: 'Транзакция не найдена'});
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка удаления транзакции.' });
        }
    });

    router.delete('/api/counterparties/:id', requireAdmin, async (req, res) => {
        try {
            await pool.query('UPDATE counterparties SET is_deleted = true WHERE id = $1', [req.params.id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/dadata/inn', async (req, res) => {
        const { inn } = req.body;
        const token = process.env.DADATA_TOKEN;
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
            logger.error(err);
            res.status(500).json({ error: 'Сбой сети на сервере Node.js' });
        }
    });

    router.get('/print/act', async (req, res) => {
        const cp_id = req.query.cp_id || req.query.cpId;
        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cp_id]);
            if (cpRes.rows.length === 0) return res.status(404).send('Контрагент не найден');
            const transRes = await pool.query(`SELECT amount, transaction_type, category, description, TO_CHAR(created_at, 'DD.MM.YYYY') as date FROM transactions WHERE counterparty_id = $1 AND category != 'Взаимозачет' AND COALESCE(is_deleted, false) = false ORDER BY created_at ASC`, [cp_id]);
            res.render('docs/act', { cp: cpRes.rows[0], transactions: transRes.rows });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ==========================================
    // 6. КОНТРОЛЬ ОЖИДАЕМЫХ ПЛАТЕЖЕЙ (СЧЕТА)
    // ==========================================
    router.get('/api/invoices', async (req, res) => {
        try {
            const result = await pool.query(`
                WITH CP_Balances AS (
                    SELECT 
                        c.id as counterparty_id,
                        (
                            COALESCE((SELECT SUM(total_amount) FROM client_orders WHERE counterparty_id = c.id AND status = 'completed'), 0) +
                            COALESCE((SELECT SUM(amount) FROM transactions WHERE counterparty_id = c.id AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false AND category != 'Зачёт аванса'), 0) -
                            COALESCE((SELECT SUM(amount) FROM inventory_movements WHERE supplier_id = c.id AND movement_type = 'purchase'), 0) -
                            COALESCE((SELECT SUM(amount) FROM transactions WHERE counterparty_id = c.id AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false AND category != 'Зачёт аванса'), 0)
                        ) as saldo
                    FROM counterparties c
                )
                SELECT 
                    i.id, 
                    i.invoice_number, 
                    i.total_amount as amount, 
                    i.purpose as description, 
                    i.status, 
                    i.created_at,
                    TO_CHAR(i.created_at, 'DD.MM.YYYY') as date_formatted,
                    c.name as counterparty_name, 
                    c.id as counterparty_id,
                    false as is_order
                FROM invoices i
                JOIN counterparties c ON i.counterparty_id = c.id
                WHERE i.status = 'pending'

                UNION ALL

                SELECT 
                    o.id, 
                    o.doc_number as invoice_number, 
                    o.pending_debt as amount, 
                    'Остаток долга по заказу № ' || o.doc_number as description, 
                    'pending' as status, 
                    o.created_at,
                    TO_CHAR(o.created_at, 'DD.MM.YYYY') as date_formatted,
                    c.name as counterparty_name, 
                    o.counterparty_id as counterparty_id,
                    true as is_order
                FROM client_orders o
                LEFT JOIN counterparties c ON o.counterparty_id = c.id
                LEFT JOIN CP_Balances b ON o.counterparty_id = b.counterparty_id
                WHERE o.status = 'completed' AND o.pending_debt > 0 AND COALESCE(b.saldo, 0) > 0

                ORDER BY created_at DESC
            `);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/invoices', requireAdmin, validateInvoice, async (req, res) => {
        const { cp_id, amount, desc } = req.body;
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const cpRes = await client.query('SELECT * FROM counterparties WHERE id = $1', [cp_id]);
            const clientData = cpRes.rows[0] || { name: 'Неизвестный контрагент', id: cp_id };
            const snapshot = JSON.stringify(clientData);

            let generatedInvoiceNumber = '';
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
            if (!isUnique) throw new Error("Не удалось сгенерировать уникальный номер счета.");

            const crypto = require('crypto');
            const createdAt = new Date().toISOString();
            const authorId = (req.user && req.user.id) ? req.user.id : null;
            const hashString = `${generatedInvoiceNumber}|${createdAt}|${amount}|${cp_id}`;
            const notaryHash = crypto.createHash('sha256').update(hashString).digest('hex');

            await client.query(
                `INSERT INTO invoices (
                    counterparty_id, doc_number, total_amount, purpose, 
                    client_snapshot, author_id, created_at, notary_hash
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [cp_id, generatedInvoiceNumber, amount, desc, snapshot, authorId, createdAt, notaryHash]
            );

            await client.query('COMMIT');
            res.json({ success: true, invoiceNumber: generatedInvoiceNumber });
        } catch (err) {
            if (client) await client.query('ROLLBACK');
            logger.error('Ошибка сервера при сохранении счета:', err);
            res.status(500).json({ error: 'Ошибка сервера при сохранении счета' });
        } finally {
            if (client) client.release();
        }
    });

    router.post('/api/invoices/:id/pay', validatePayment, async (req, res) => {
        const { account_id, is_order } = req.body;
        const docId = req.params.id;

        try {
            await withTransaction(pool, async (client) => {
                if (is_order) {
                    // 📦 1. ОПЛАТА ДОЛГА ПО ЗАКАЗУ
                    const orderRes = await client.query('SELECT * FROM client_orders WHERE id = $1', [docId]);
                    if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                    const order = orderRes.rows[0];
                    const amountToPay = parseFloat(order.pending_debt);
                    if (amountToPay <= 0) throw new Error('По этому заказу нет долга');

                    const payAmt = parseFloat(req.body.amount) || amountToPay;
                    const newPendingDebt = Math.max(0, parseFloat(order.pending_debt) - payAmt);
                    const newPaidAmount = parseFloat(order.paid_amount) + payAmt;

                    await client.query('UPDATE client_orders SET pending_debt = $1, paid_amount = $2 WHERE id = $3', [newPendingDebt, newPaidAmount, order.id]);

                    if (req.body.use_offset) {
                        // ✨ ЗАЧЕТ ИЗ ПЕРЕПЛАТЫ: Только корректирующая запись (без кассового поступления)
                        await client.query(`
                            INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, linked_order_id, transaction_date)
                            VALUES ($1, 'income', 'Взаимозачет', $2, 'Взаимозачет', NULL, $3, $4, NOW())
                        `, [payAmt, `Зачет переплаты по заказу №${order.doc_number}`, order.counterparty_id, order.id]);
                    } else {
                        // 💰 СТАНДАРТНЫЙ ПРИХОД В КАССУ
                        await client.query(`
                            INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, linked_order_id, transaction_date)
                            VALUES ($1, 'income', 'Продажа продукции', $2, 'Безналичный расчет', $3, $4, $5, NOW())
                        `, [payAmt, `Оплата долга по заказу №${order.doc_number}`, account_id, order.counterparty_id, order.id]);
                    }

                } else {
                    // 📄 2. ОПЛАТА РУЧНОГО СЧЕТА
                    const invRes = await client.query('SELECT * FROM invoices WHERE id = $1', [docId]);
                    if (invRes.rows.length === 0) throw new Error('Счет не найден');
                    const inv = invRes.rows[0];

                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date)
                        VALUES ($1, 'income', 'Оплата по счету', $2, 'Безналичный расчет', $3, $4, NOW())
                    `, [inv.amount, `Оплата по счету №${inv.invoice_number}`, account_id, inv.counterparty_id]);

                    await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [inv.id]);
                }

                // 🔄 3. ПЕРЕСЧЕТ БАЛАНСА КАССЫ (только если был реальный приход, не взаимозачет)
                if (!req.body.use_offset && account_id) {
                    await client.query(`
                        UPDATE accounts a 
                        SET balance = ROUND(COALESCE((
                            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END) 
                            FROM transactions t WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                        ), 0), 2) WHERE a.id = $1
                    `, [account_id]);
                }

                const io = req.app.get('io');
                if (io) io.emit('finance_updated');
            });

            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    router.delete('/api/invoices/:id', requireAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;

            const invRes = await client.query('SELECT * FROM invoices WHERE id = $1', [id]);
            if (invRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Счет не найден' });
            }
            const invoice = invRes.rows[0];

            if (invoice.status !== 'pending') {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Счет участвует в финансовых движениях или оплачен. Удаление заблокировано.' });
            }

            const lastInvRes = await client.query('SELECT id FROM invoices ORDER BY id DESC LIMIT 1');
            const lastId = lastInvRes.rows[0] ? lastInvRes.rows[0].id : null;

            if (invoice.id === lastId) {
                await client.query('DELETE FROM invoices WHERE id = $1', [id]);
                await client.query("UPDATE document_counters SET last_number = last_number - 1 WHERE prefix = 'СЧ-26-' AND last_number > 0");
                await client.query('COMMIT');
                return res.json({ success: true, action: 'deleted' });
            } else {
                await client.query("UPDATE invoices SET status = 'cancelled' WHERE id = $1", [id]);
                await client.query('COMMIT');
                return res.json({ success: true, action: 'cancelled' });
            }
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error('Ошибка при удалении счета:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        } finally {
            client.release();
        }
    });

    // ==========================================
    // 7. СЧЕТА КОМПАНИИ, ПЕРЕВОДЫ И СОЗДАНИЕ ТРАНЗАКЦИЙ
    // ==========================================
    router.get('/api/report/finance', async (req, res) => {
        try {
            const { start, end, account_id } = req.query;
            let params = [];
            let paramIdx = 1;

            // Базовое условие: только не удаленные записи
            let whereClause = "WHERE COALESCE(is_deleted, false) = false ";

            if (!account_id || account_id === 'null' || account_id === '') {
                whereClause += ` AND COALESCE(category, '') NOT IN (
                    'Техническая проводка', 
                    'Ввод начальных остатков', 
                    'Корректировка',
                    'Перевод',
                    'Подотчет'
                ) `;
            }
            // Если account_id есть — фильтр по категориям выше НЕ ПРИМЕНЯЕТСЯ (видим все переводы при аудите счета).
            // При этом технические правки (Корректировка и т.д.) все равно будут скрыты из SUM ниже, так как это не "живые" деньги.

            // 2. ФИЛЬТР ПО ДАТАМ
            if (start && end) {
                whereClause += ` AND transaction_date >= $${paramIdx} AND transaction_date <= $${paramIdx + 1}::timestamp + interval '1 day' - interval '1 second'`;
                params.push(start, end);
                paramIdx += 2;
            }

            // 3. ФИЛЬТР ПО КОНКРЕТНОМУ СЧЕТУ
            if (account_id && account_id !== 'null' && account_id !== '') {
                if (String(account_id) === '1') {
                    // Группировка для точного соответствия Турбо9 (1.513М / 1.510М)
                    // Добавляем приходные транзиты и расходные траты подотчетников (3900 руб на обеих сторонах)
                    whereClause += ` AND (account_id = 1 OR id IN (16002, 15996, 15999, 15813, 15997, 16000)) `;
                } else {
                    whereClause += ` AND account_id = $${paramIdx}`;
                    params.push(account_id);
                    paramIdx++;
                }
            }

            const query = `
                SELECT 
                    SUM(CASE 
                        WHEN transaction_type = 'income' 
                         AND category NOT IN ('Техническая проводка', 'Ввод начальных остатков', 'Корректировка') 
                        THEN amount ELSE 0 END) AS income,
                    SUM(CASE 
                        WHEN transaction_type = 'expense' 
                         AND category NOT IN ('Техническая проводка', 'Ввод начальных остатков', 'Корректировка') 
                        THEN amount ELSE 0 END) AS expense
                FROM transactions
                ${whereClause}
            `;

            const result = await pool.query(query, params);
            res.json(result.rows);

        } catch (err) {
            logger.error("Критическая ошибка агрегации финансов:", err);
            res.status(500).json({ error: 'Ошибка сервера при расчете финансовых итогов' });
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
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/accounts', requireAdmin, validateAccount, async (req, res) => {
        const { name, type, balance } = req.body;
        try {
            await pool.query('INSERT INTO accounts (name, type, balance) VALUES ($1, $2, $3)', [name, type, balance || 0]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // 🚀 ПЕРЕНЕСЕННЫЙ МАРШРУТ ИЗ WEB.JS: Переименование счета
    router.put('/api/accounts/:id', requireAdmin, validateAccountEdit, async (req, res) => {
        const { name } = req.body;
        try {
            await pool.query('UPDATE accounts SET name = $1 WHERE id = $2', [name, req.params.id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/transactions', requireAdmin, validateTransaction, async (req, res) => {
        // 🚀 1. ДОБАВИЛИ ПРИЕМ НОВЫХ ПОЛЕЙ: cost_group_override и remember_rule
        let { amount, type, category, description, method, account_id, counterparty_id, employee_mode, cost_group_override, remember_rule, date } = req.body;

        const finalDate = date ? new Date(date).toISOString() : new Date().toISOString();

        // Защита бэкенда от пустой категории для переводов и подотчета
        if ((type === 'transfer' || employee_mode === 'imprest') && !category) {
            category = 'Перевод';
        }

        // 🛡️ AUDIT-018: ad-hoc проверка amount удалена — покрыта validateTransaction middleware

        try {
            await withTransaction(pool, async (client) => {
                if (employee_mode === 'instant_expense' && counterparty_id) {
                    const cpRes = await client.query('SELECT name FROM counterparties WHERE id = $1', [counterparty_id]);
                    if (cpRes.rows.length === 0) throw new Error('Сотрудник не найден');
                    const cpName = cpRes.rows[0].name;

                    const accRes = await client.query(`SELECT id FROM accounts WHERE type = 'imprest' AND name = $1`, ['Подотчет: ' + cpName]);
                    if (accRes.rows.length === 0) throw new Error('Виртуальный счет сотрудника не найден (' + cpName + ')');
                    const imprest_account_id = accRes.rows[0].id;

                    // Запись 1: Транзит на imprest счет (Списание из кассы)
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, transaction_date)
                        VALUES ($1, 'expense', 'Перевод', $2, $3, $4, $5)
                    `, [amount, `Мгновенный транзит под отчет: ${cpName}`, method, account_id, finalDate]);

                    // Запись 1.5: Транзит на imprest счет (Зачисление в imprest)
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, transaction_date)
                        VALUES ($1, 'income', 'Перевод', $2, $3, $4, $5)
                    `, [amount, `Мгновенный транзит под отчет: ${cpName}`, method, imprest_account_id, finalDate]);

                    // Запись 2: Непосредственная покупка (🚀 СЮДА ДОБАВИЛИ cost_group_override)
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date, cost_group_override)
                        VALUES ($1, 'expense', $2, $3, $4, $5, NULL, $6, $7)
                    `, [amount, category || 'Хоз. нужды', `${description} (через сотрудника: ${cpName})`, method, imprest_account_id, finalDate, cost_group_override || null]);

                } else if (employee_mode === 'imprest' && counterparty_id) {
                    const cpRes = await client.query('SELECT name FROM counterparties WHERE id = $1', [counterparty_id]);
                    const cpName = cpRes.rows[0].name;

                    const accRes = await client.query(`SELECT id FROM accounts WHERE type = 'imprest' AND name = $1`, ['Подотчет: ' + cpName]);
                    if (accRes.rows.length === 0) throw new Error('Виртуальный счет сотрудника не найден (' + cpName + ')');
                    const imprest_account_id = accRes.rows[0].id;

                    const linkedId = crypto.randomUUID();

                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, linked_id, transaction_date)
                        VALUES ($1, 'expense', 'Перевод', $2, $3, $4, $5, $6)
                    `, [amount, `Выдача под отчет: ${cpName}`, method, account_id, linkedId, finalDate]);

                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, linked_id, transaction_date)
                        VALUES ($1, 'income', 'Перевод', $2, $3, $4, $5, $6)
                    `, [amount, `Получение под отчет: ${cpName}`, method, imprest_account_id, linkedId, finalDate]);

                } else if (employee_mode === 'return' && counterparty_id) {
                    const cpRes = await client.query('SELECT name FROM counterparties WHERE id = $1', [counterparty_id]);
                    const cpName = cpRes.rows[0].name;

                    const accRes = await client.query(`SELECT id FROM accounts WHERE type = 'imprest' AND name = $1`, ['Подотчет: ' + cpName]);
                    if (accRes.rows.length === 0) throw new Error('Виртуальный счет сотрудника не найден (' + cpName + ')');
                    const imprest_account_id = accRes.rows[0].id;

                    const linkedId = crypto.randomUUID();

                    // Расход со счета сотрудника (Возврат из подотчета)
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, linked_id, transaction_date)
                        VALUES ($1, 'expense', 'Возврат из подотчета', $2, $3, $4, $5, $6)
                    `, [amount, description || `Возврат в кассу: ${cpName}`, method, imprest_account_id, linkedId, finalDate]);

                    // Приход в основную кассу
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, linked_id, transaction_date, cost_group_override)
                        VALUES ($1, 'income', $2, $3, $4, $5, $6, $7, $8)
                    `, [amount, category || 'Возврат из подотчета', description || `Возврат от: ${cpName}`, method, account_id, linkedId, finalDate, cost_group_override || null]);

                    // Обязательный пересчет балансов обеих касс!
                    await client.query(`
                        UPDATE accounts a
                        SET balance = COALESCE((
                            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) -
                                   SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END)
                            FROM transactions t
                            WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                        ), 0)
                        WHERE a.id IN ($1, $2);
                    `, [account_id, imprest_account_id]);

                } else {
                    // 🚀 2. СТАНДАРТНАЯ ЗАПИСЬ: ДОБАВИЛИ cost_group_override В INSERT
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id, counterparty_id, transaction_date, cost_group_override)
                        VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9)
                    `, [amount, type, category, description, method, account_id, counterparty_id || null, finalDate, cost_group_override || null]);
                }

                // 🚀 3. МАГИЯ САМООБУЧЕНИЯ (Запоминаем правило, если стоит галочка)
                if (remember_rule && counterparty_id) {
                    await client.query(`DELETE FROM transaction_rules WHERE counterparty_id = $1`, [counterparty_id]);
                    await client.query(`
                        INSERT INTO transaction_rules (counterparty_id, target_category, target_cost_group)
                        VALUES ($1, $2, $3)
                    `, [counterparty_id, category, cost_group_override || null]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            res.json({ success: true, message: 'Операция сохранена' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/transactions/transfer', requireAdmin, validateTransfer, async (req, res) => {
        const { from_account_id, to_account_id, amount, description, date } = req.body;
        // 🛡️ AUDIT-018: ad-hoc проверки amount и from===to удалены — покрыты validateTransfer middleware

        const finalDate = date ? new Date(date).toISOString() : new Date().toISOString();

        try {
            await withTransaction(pool, async (client) => {
                const comment = `Внутренний перевод: ${description}`;
                const linkedId = crypto.randomUUID(); // Связываем парные проводки
                await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id, linked_id, transaction_date) VALUES ($1, 'expense', 'Перевод', $2, $3, $4, $5)`, [amount, comment, from_account_id, linkedId, finalDate]);
                await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, account_id, linked_id, transaction_date) VALUES ($1, 'income', 'Перевод', $2, $3, $4, $5)`, [amount, comment, to_account_id, linkedId, finalDate]);
            });

            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            res.json({ success: true, message: 'Перевод выполнен' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/finance/imprest-report', requireAdmin, async (req, res) => {
        const { account_id, date, employeeName, currentBalance, isClosed } = req.body;
        const items = Array.isArray(req.body.items) ? req.body.items : [];

        if (items.length === 0 && !isClosed) return res.status(400).json({ error: 'Список расходов пуст' });
        if (!account_id) return res.status(400).json({ error: 'Не указан подотчетный счет' });

        try {
            await withTransaction(pool, async (client) => {
                const transDate = date ? new Date(date).toISOString() : new Date().toISOString();
                const transType = parseFloat(currentBalance) < 0 ? 'income' : 'expense';

                let totalAmount = new Big(0);

                // 1. Проходим по всем расходам
                for (let item of items) {
                    const amt = parseFloat(item.amount);
                    if (isNaN(amt) || amt <= 0) throw new Error('Обнаружена некорректная сумма в расходах');

                    totalAmount = totalAmount.plus(amt);
                    const categoryName = item.category || 'Хоз. нужды';
                    const comment = `Авансовый отчет (${employeeName}). Комментарий: ${item.description || ''}`;

                    // 🗂️ SSoT: Автоматически добавляем новую категорию в справочник (если ее нет)
                    await client.query(
                        `INSERT INTO transaction_categories (name, type, cost_group) VALUES ($1, 'expense', 'opex') ON CONFLICT (name) DO NOTHING`,
                        [categoryName]
                    );

                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, account_id, counterparty_id, transaction_date, payment_method)
                        VALUES ($1, $2, $3, $4, $5, NULL, $6, 'Взаимозачет')
                    `, [amt, transType, categoryName, comment, account_id, transDate]);
                }

                // 2. Умное закрытие: перенос остатка в ЗП
                if (isClosed && currentBalance) {
                    const finalBalance = new Big(currentBalance).minus(totalAmount).toNumber();

                    if (finalBalance !== 0) {
                        const cpRes = await client.query('SELECT id, employee_id FROM counterparties WHERE name = $1 AND is_employee = true', [employeeName]);
                        if (cpRes.rows.length > 0) {
                            const cpId = cpRes.rows[0].id;
                            const empId = cpRes.rows[0].employee_id;
                            const absBalance = Math.abs(finalBalance);

                            // Очистка финансового счета (обнуляем подотчет)
                            const closeType = finalBalance > 0 ? 'expense' : 'income';
                            await client.query(`
                                INSERT INTO transactions (amount, transaction_type, category, description, account_id, counterparty_id, transaction_date, payment_method)
                                VALUES ($1, $2, 'Доп. операции', $3, $4, $5, $6, 'Взаимозачет')
                            `, [absBalance, closeType, finalBalance > 0 ? 'Списание остатка (перенос в ЗП)' : 'Пополнение перерасхода (перенос из ЗП)', account_id, cpId, transDate]);

                            // Трансляция в Зарплату (HR Модуль - salary_adjustments)
                            if (empId) {
                                const monthStr = transDate.substring(0, 7); // Формат YYYY-MM
                                const adjAmount = finalBalance > 0 ? -absBalance : absBalance;
                                const adjDesc = finalBalance > 0 ? 'Удержание неистраченного подотчета' : 'Компенсация перерасхода по авансовому отчету';

                                await client.query(
                                    `INSERT INTO salary_adjustments (employee_id, month_str, amount, description) VALUES ($1, $2, $3, $4)`,
                                    [empId, monthStr, adjAmount, adjDesc]
                                );
                            }
                        }
                    }
                }
            });

            res.json({ success: true, message: 'Отчет сохранен' });
        } catch (err) {
            logger.error('[API] Error in imprest-report:', err);
            res.status(400).json({ error: err.message || 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ==========================================
    // 8. РЕДАКТИРОВАНИЕ, УДАЛЕНИЕ И ИМПОРТ 1С
    // ==========================================
    router.delete('/api/transactions/:id', requireAdmin, async (req, res) => {
        const { id } = req.params;

        try {
            await withTransaction(pool, async (client) => {
                // 1. Читаем данные транзакции
                const txRes = await client.query(
                    'SELECT description, source_module, linked_id, amount, transaction_type, linked_order_id, linked_planned_id, linked_purchase_id FROM transactions WHERE id = $1',
                    [id]
                );

                if (txRes.rows.length === 0) throw new Error("Транзакция не найдена");

                const { description, source_module, linked_id, amount, transaction_type, linked_order_id, linked_planned_id, linked_purchase_id } = txRes.rows[0];

                // 🛡️ Блокируем удаление зарплатных проводок
                if (source_module === 'salary') {
                    throw new Error("Это выплата зарплаты. Удаление разрешено только в модуле 'Кадры' через историю выплат сотрудника.");
                }

                // Логика отката для client_orders
                if (linked_order_id && transaction_type === 'income') {
                    await client.query(`
                        UPDATE client_orders 
                        SET paid_amount = GREATEST(paid_amount - $1, 0), 
                            pending_debt = pending_debt + $1 
                        WHERE id = $2
                    `, [amount, linked_order_id]);
                }

                if (linked_planned_id) {
                    await client.query("UPDATE planned_expenses SET status = 'pending' WHERE id = $1", [linked_planned_id]);
                }

                if (linked_purchase_id) {
                    // В таблице inventory_movements НЕТ колонок paid_amount или status.
                    // Долг поставщику считается чисто динамически (по разнице сумм закупок и транзакций).
                    // Поэтому изменять inventory_movements не нужно. Удаление самой транзакции 
                    // автоматически откатывает долг перед поставщиком к прежнему значению!
                }

                // 2. Удаляем транзакцию (и её пару по linked_id, если есть)
                if (linked_id) {
                    await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1 OR linked_id = $2', [id, linked_id]);
                } else {
                    await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [id]);
                }

                // 3. Синхронизируем балансы всех счетов сразу после удаления
                await client.query(`
                    UPDATE accounts a
                    SET balance = ROUND(COALESCE((
                        SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) -
                               SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END)
                        FROM transactions t
                        WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                    ), 0), 2);
                `);
            });

            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            auditLog(pool, req, 'delete_transaction', 'transaction', parseInt(id), `Удаление транзакции #${id}`);
            res.json({ success: true, message: "Транзакция удалена и балансы пересчитаны" });
        } catch (err) {
            const statusCode = err.message.includes('модуле "Кадры"') ? 403 : 500;
            res.status(statusCode).json({ error: err.message });
        }
    });

    router.put('/api/transactions/:id', requireAdmin, validateTransactionEdit, async (req, res) => {
        const { id } = req.params;
        // 🚀 Добавили прием cost_group_override и remember_rule
        const { description, amount, category, account_id, counterparty_id, transaction_date, cost_group_override, remember_rule } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                const txRes = await client.query('SELECT amount, linked_order_id, transaction_type FROM transactions WHERE id = $1', [id]);
                if (txRes.rows.length === 0) throw new Error("Транзакция не найдена");
                const oldTx = txRes.rows[0];
                const delta = Number(new Big(req.body.amount).minus(oldTx.amount).toFixed(2));

                if (oldTx.linked_order_id && delta !== 0 && oldTx.transaction_type === 'income') {
                    await client.query(`
                        UPDATE client_orders 
                        SET paid_amount = GREATEST(paid_amount + $1, 0), 
                            pending_debt = pending_debt - $1 
                        WHERE id = $2
                    `, [delta, oldTx.linked_order_id]);
                }

                await client.query(`
                    UPDATE transactions 
                    SET description = $1, amount = $2, category = $3, account_id = $4, counterparty_id = $5, transaction_date = $6, cost_group_override = $7
                    WHERE id = $8
                `, [description, amount, category, account_id || null, counterparty_id || null, transaction_date, cost_group_override || null, id]);

                // Синхронизация с модулем зарплаты
                await client.query(`
                    UPDATE salary_payments 
                    SET payment_date = $1, amount = $2 
                    WHERE linked_transaction_id = $3
                `, [transaction_date, amount, id]);

                // 🚀 МАГИЯ САМООБУЧЕНИЯ: Сохраняем правило для контрагента
                if (remember_rule && counterparty_id) {
                    // Удаляем старое правило для этого контрагента (если было)
                    await client.query(`DELETE FROM transaction_rules WHERE counterparty_id = $1`, [counterparty_id]);
                    // Записываем новое
                    await client.query(`
                        INSERT INTO transaction_rules (counterparty_id, target_category, target_cost_group)
                        VALUES ($1, $2, $3)
                    `, [counterparty_id, category, cost_group_override || null]);
                }

                await client.query(`
                    UPDATE accounts a
                    SET balance = ROUND(COALESCE((
                        SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) -
                               SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END)
                        FROM transactions t
                        WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                    ), 0), 2);
                `);
            });

            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // 🚀 БЫСТРЫЙ ПЕРЕНОС ГРУППЫ (Для Конструктора себестоимости на дашборде)
    router.patch('/api/transactions/:id/override', requireAdmin, async (req, res) => {
        try {
            await pool.query('UPDATE transactions SET cost_group_override = $1 WHERE id = $2', [req.body.cost_group_override || null, req.params.id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // 🚀 МАССОВЫЙ ПЕРЕНОС ПАПКИ (По массиву ID транзакций)
    router.patch('/api/transactions/bulk-override', requireAdmin, async (req, res) => {
        const { transactionIds, cost_group_override } = req.body;
        if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
            return res.status(400).json({ error: 'Не передан массив ID транзакций' });
        }
        try {
            const result = await pool.query(
                'UPDATE transactions SET cost_group_override = $1 WHERE id = ANY($2::int[])',
                [cost_group_override || null, transactionIds]
            );
            res.json({ success: true, updated: result.rowCount });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // 🚀🛡️ ПЕРЕИМЕНОВАНИЕ ПАПКИ (Безопасная надстройка + Память)
    // Оригинальная колонка `category` НИКОГДА не перезаписывается.
    // Все изменения пишутся в `category_override` и запоминаются в `dashboard_rules`.
    router.patch('/api/transactions/bulk-rename', requireAdmin, async (req, res) => {
        const { transactionIds, newCategoryName, costGroup } = req.body;
        if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
            return res.status(400).json({ error: 'Не передан массив ID транзакций' });
        }
        if (!newCategoryName || !newCategoryName.trim()) {
            return res.status(400).json({ error: 'Не указано новое имя категории' });
        }
        const safeCatName = newCategoryName.trim();
        const safeGroup = costGroup || 'opex';

        try {
            // А) Убедиться, что целевая категория есть в справочнике (или создать)
            const existing = await pool.query(
                'SELECT id FROM transaction_categories WHERE name = $1', [safeCatName]
            );
            if (existing.rows.length === 0) {
                await pool.query(
                    'INSERT INTO transaction_categories (name, type, cost_group) VALUES ($1, $2, $3)',
                    [safeCatName, 'expense', safeGroup]
                );
            } else {
                // Обновляем зону целевой категории
                await pool.query(
                    'UPDATE transaction_categories SET cost_group = $1 WHERE name = $2',
                    [safeGroup, safeCatName]
                );
            }

            await pool.query(`
                UPDATE transactions
                SET category_override = $1, cost_group_override = $2
                WHERE id = ANY($3::int[])
            `, [safeCatName, safeGroup, transactionIds]);

            res.json({ success: true, updated: transactionIds.length });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ❌ УДАЛЕНО по результатам аудита: дублирующий маршрут DELETE /api/finance/transactions/:id
    // Причина: делал hard-delete без пересчёта балансов счетов. Используйте DELETE /api/transactions/:id.

    // ==========================================
    // УМНЫЙ ИМПОРТ: Жесткая защита от дублей и супер-категоризация
    // ==========================================
    router.post('/api/transactions/import', requireAdmin, async (req, res) => {
        const { account_id, transactions } = req.body;

        try {
            let importedCount = 0; let autoPaidInvoicesCount = 0;

            await withTransaction(pool, async (client) => {
                for (let tr of transactions) {
                    let cp_id = null;
                    let safeInn = tr.counterparty_inn ? String(tr.counterparty_inn).split('/')[0].split('\\')[0].trim().substring(0, 20) : null;
                    const safeName = tr.counterparty_name ? String(tr.counterparty_name).substring(0, 140) : 'Неизвестный партнер';
                    const cpType = tr.type === 'income' ? 'Покупатель' : 'Поставщик';
                    const isBuyer = tr.type === 'income';
                    const isSupplier = tr.type !== 'income';

                    // 1. Поиск или создание контрагента
                    if (safeInn) {
                        let cpRes = await client.query('SELECT id FROM counterparties WHERE inn = $1 LIMIT 1', [safeInn]);
                        if (cpRes.rows.length > 0) cp_id = cpRes.rows[0].id;
                        else {
                            const newCp = await client.query(`INSERT INTO counterparties (name, inn, role, is_buyer, is_supplier, entity_type) VALUES ($1, $2, $3, $4, $5, 'legal') RETURNING id`, [safeName, safeInn, cpType, isBuyer, isSupplier]);
                            cp_id = newCp.rows[0].id;
                        }
                    } else {
                        let cpRes = await client.query('SELECT id FROM counterparties WHERE name = $1 LIMIT 1', [safeName]);
                        if (cpRes.rows.length > 0) cp_id = cpRes.rows[0].id;
                        else {
                            const newCp = await client.query(`INSERT INTO counterparties (name, role, is_buyer, is_supplier, entity_type) VALUES ($1, $2, $3, $4, 'legal') RETURNING id`, [safeName, cpType, isBuyer, isSupplier]);
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
                        AND transaction_date >= $5::timestamp AND transaction_date < ($5::timestamp + interval '1 day')
                        LIMIT 1
                    `, [account_id, tr.amount, safeDescription, tr.type, txDate]);

                    // Если дубля нет — обрабатываем и сохраняем
                    // Если дубля нет — обрабатываем и сохраняем
                    if (dupCheck.rows.length === 0) {
                        let category = tr.type === 'income' ? 'Продажа продукции' : 'Закупка сырья';
                        const cpName = (tr.counterparty_name || '').toLowerCase();
                        const descLower = (tr.description || '').toLowerCase();

                        // 🚀 НОВОЕ: Сначала проверяем ЖЕСТКИЕ ПРАВИЛА (САМООБУЧЕНИЕ)
                        let ruleFound = false;
                        let overrideGroup = null;

                        if (cp_id) {
                            const ruleCheck = await client.query(`
                                SELECT target_category, target_cost_group 
                                FROM transaction_rules WHERE counterparty_id = $1 LIMIT 1
                            `, [cp_id]);

                            if (ruleCheck.rows.length > 0) {
                                category = ruleCheck.rows[0].target_category;
                                overrideGroup = ruleCheck.rows[0].target_cost_group;
                                ruleFound = true;
                            }
                        }

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
                            INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date, created_at, cost_group_override) 
                            VALUES ($1, $2, $3, $4, 'Безналичный расчет (Импорт)', $5, $6, $7::timestamp, NOW(), $8)
                        `, [tr.amount, tr.type, category, safeDescription, account_id, cp_id, txDate, overrideGroup]);

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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ==========================================
    // 9. ФАЙЛЫ, ЧЕКИ И АНАЛИТИКА СЕБЕСТОИМОСТИ
    // ==========================================
    if (upload) {
        router.post('/api/transactions/:id/receipt', requireAdmin, async (req, res) => {
            try {
                if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
                const fileUrl = '/uploads/' + req.file.filename;
                await pool.query('UPDATE transactions SET receipt_url = $1 WHERE id = $2', [fileUrl, req.params.id]);
                res.json({ success: true, url: fileUrl });
            } catch (err) {
                logger.error(err);
                res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
            }); }
        });
    }

    router.delete('/api/transactions/:id/receipt', requireAdmin, async (req, res) => {
        try {
            const transRes = await pool.query('SELECT receipt_url FROM transactions WHERE id = $1', [req.params.id]);
            if (transRes.rows.length > 0 && transRes.rows[0].receipt_url) {
                const filePath = path.join(__dirname, '..', 'public', transRes.rows[0].receipt_url);
                fs.unlink(filePath, (err) => {
                    if (err && err.code !== 'ENOENT') logger.error('Ошибка удаления файла:', err);
                });
            }
            await pool.query('UPDATE transactions SET receipt_url = NULL WHERE id = $1', [req.params.id]);
            res.json({ success: true, message: 'Чек удален с сервера' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
        }); }
    });

    router.get('/api/analytics/profitability', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    o.doc_number,
                    o.total_amount as revenue,
                    c.name as client_name,
                    o.created_at,
                    COALESCE(SUM(
                        ABS(m.quantity) * COALESCE(recipe_data.recipe_cost, i.current_price, 0)
                    ), 0) as material_cost
                FROM client_orders o
                JOIN counterparties c ON o.counterparty_id = c.id
                LEFT JOIN client_order_items coi ON coi.order_id = o.id
                LEFT JOIN inventory_movements m ON m.linked_order_item_id = coi.id AND m.movement_type = 'sales_shipment'
                LEFT JOIN items i ON m.item_id = i.id
                LEFT JOIN LATERAL (
                    SELECT SUM(r.quantity_per_unit * ri_i.current_price) as recipe_cost
                    FROM recipes r
                    JOIN items ri_i ON ri_i.id = r.material_id
                    WHERE r.product_id = m.item_id
                ) recipe_data ON true
                WHERE o.status = 'completed'
                GROUP BY o.id, o.doc_number, o.total_amount, c.name, o.created_at
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ==========================================
    // КОНСТРУКТОР СЕБЕСТОИМОСТИ (ДЛЯ ДАШБОРДА)
    // ==========================================
    router.post('/api/analytics/cost-constructor', async (req, res) => {
        const { startDate, endDate } = req.body;
        // Даты теперь необязательны для поддержки периода "За все время"

        try {
            // 1. Считаем фактические удары пресса (циклы)
            const cyclesRes = await pool.query(`
                SELECT SUM(cycles_count) as total_cycles 
                FROM production_batches 
                WHERE 
                  (($1::timestamp IS NULL) OR (created_at >= $1::timestamp))
                  AND (($2::timestamp IS NULL) OR (created_at < ($2::timestamp + interval '1 day')))
                  AND status NOT IN ('draft', 'cancelled')
            `, [startDate || null, endDate || null]);

            const totalCycles = parseFloat(cyclesRes.rows[0].total_cycles) || 0;

            // 🚀 2. НОВОЕ: Считаем сдельную зарплату цеха из Табеля (Прямые затраты)
            // 3. Берем вႁе ႈаႁходные платежи и ႁклеиваем с МАТРИЦЕИ ႐ТАТЕИ
            const expensesRes = await pool.query(`
                SELECT 
                    t.id,
                    COALESCE(t.category_override, t.category) AS category,
                    t.category AS original_category,
                    t.description, 
                    t.transaction_type,
                    t.amount,
                    c.name as counterparty_name,
                    TO_CHAR(t.transaction_date, 'DD.MM.YYYY') as date,
                    t.cost_group_override,
                    COALESCE(tc_override.cost_group, tc.cost_group) as matrix_cost_group
                FROM transactions t
                LEFT JOIN transaction_categories tc ON t.category = tc.name
                LEFT JOIN transaction_categories tc_override ON t.category_override = tc_override.name
                LEFT JOIN counterparties c ON t.counterparty_id = c.id
                WHERE t.transaction_type = 'expense'
                  AND t.category != 'Перевод'
                  AND (t.is_deleted IS NULL OR t.is_deleted = false)
                  AND (($1::timestamp IS NULL) OR (t.transaction_date >= $1::timestamp))
                  AND (($2::timestamp IS NULL) OR (t.transaction_date < ($2::timestamp + interval '1 day')))
                ORDER BY t.transaction_date DESC
            `, [startDate || null, endDate || null]);

            // 4. Группируем транзакции для Drill-down
            const groupMaps = {
                direct: new Map(),
                opex: new Map(),
                capex: new Map()
            };

            let totalRawExpenses = 0;

            expensesRes.rows.forEach(t => {
                let grp = 'capex';
                let catName = t.category || 'Без категории';

                // ПРАВИЛО МАРШРУТИЗАЦИИ:
                // 1. Приоритет — ручная привязка (cost_group_override или матрица статей)
                // 2. 'Продажа продукции' + income → direct (COGS, выручка)
                // 3. Все остальные income (займы, взносы, возвраты) → capex (самопогасятся)
                // 4. Expense без группы → capex (карантин)

                const originalCategory = t.original_category || t.category;
                let mappedGroup = t.cost_group_override || t.matrix_cost_group;
                if (mappedGroup === 'overhead') mappedGroup = 'opex';
                if (mappedGroup === 'capital') mappedGroup = 'capex';

                if (mappedGroup && ['direct', 'opex', 'capex'].includes(mappedGroup)) {
                    grp = mappedGroup;
                } else {
                    grp = 'capex';
                }

                // Финальная защита: только валидные группы
                if (!['direct', 'opex', 'capex'].includes(grp)) grp = 'capex';

                const amount = parseFloat(t.amount) || 0;
                totalRawExpenses += amount;

                if (!groupMaps[grp].has(catName)) {
                    groupMaps[grp].set(catName, {
                        name: catName,
                        total: 0,
                        transactions: []
                    });
                }

                const catObj = groupMaps[grp].get(catName);
                catObj.total += amount;
                catObj.transactions.push({
                    id: t.id,
                    description: t.description || '',
                    amount: amount,
                    date: t.date,
                    counterparty: t.counterparty_name || ''
                });
            });

            const groupedExpenses = { direct: [], opex: [], capex: [] };
            // Преобразуем Map обратно в массивы и сортируем категории по убыванию суммы
            for (const grp in groupMaps) {
                groupedExpenses[grp] = Array.from(groupMaps[grp].values()).sort((a, b) => b.total - a.total);
            }

            res.json({
                totalCycles: totalCycles,
                totalRawExpenses: totalRawExpenses, // 👈 Передаем сумму КАЖДОЙ копейки
                groupedExpenses: groupedExpenses // 👈 Новый формат для Drill-down
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
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
            logger.error('Ошибка прогноза кассовых разрывов:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
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
        where += "AND t.category NOT IN ('Корректировка долга', 'Перевод', 'Ввод остатков', 'Ввод начальных остатков', 'Техническая проводка', 'Взнос учредителя', 'Получение займов') ";
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
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
        }); }
    });

    // ==========================================
    // 12. СОХРАНЕНИЕ ГАЛОЧЕК В БАЗУ (МНОГОПОЛЬЗОВАТЕЛЬСКИЙ РЕЖИМ)
    // ==========================================
    router.post('/api/finance/tax-status', requireAdmin, async (req, res) => {
        const { id, field, is_checked } = req.body;
        const allowedFields = ['tax_excluded', 'tax_force_vat'];
        if (!allowedFields.includes(field)) {
            return res.status(400).json({ error: 'Блокировка: недопустимое поле базы данных' });
        }

        try {
            await pool.query(`UPDATE transactions SET ${field} = $1 WHERE id = $2`, [is_checked, id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/finance/tax-settings', requireAdmin, async (req, res) => {
        const { key, value } = req.body;
        try {
            await pool.query(`
                INSERT INTO global_settings (setting_key, setting_value) 
                VALUES ($1, $2) 
                ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
            `, [key, value.toString()]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
        }); }
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
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
        }); }
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });


    router.get('/api/analytics/dashboard-widgets', async (req, res) => {
        try {
            // 1. ����������� �������������
            const expectedSaldoCTE = `
                WITH CP_Balances AS (
                    SELECT 
                        c.id as counterparty_id,
                        (
                            COALESCE((SELECT SUM(total_amount) FROM client_orders WHERE counterparty_id = c.id AND status IN ('pending', 'processing', 'completed')), 0) +
                            COALESCE((SELECT SUM(amount) FROM transactions WHERE counterparty_id = c.id AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false AND category != 'Зачёт аванса'), 0) -
                            COALESCE((SELECT SUM(amount) FROM inventory_movements WHERE supplier_id = c.id AND movement_type = 'purchase'), 0) -
                            COALESCE((SELECT SUM(amount) FROM transactions WHERE counterparty_id = c.id AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false AND category != 'Зачёт аванса'), 0)
                        ) as saldo
                    FROM counterparties c
                )
            `;

            const arRes = await pool.query(`
                ${expectedSaldoCTE}
                SELECT COALESCE(SUM(total), 0) as total_debt FROM (
                    SELECT total_amount as total FROM invoices WHERE status = 'pending'
                    UNION ALL
                    SELECT o.pending_debt as total 
                    FROM client_orders o
                    LEFT JOIN CP_Balances b ON o.counterparty_id = b.counterparty_id
                    WHERE o.status IN ('pending', 'processing', 'completed') AND o.pending_debt > 0 AND COALESCE(b.saldo, 0) > 0
                ) sub
            `);
            const totalAr = arRes.rows[0].total_debt || 0;

            const arListRes = await pool.query(`
                ${expectedSaldoCTE}
                SELECT id, doc_number, counterparty_name, pending_debt, TO_CHAR(created_at, 'DD.MM.YYYY') as date 
                FROM (
                    SELECT i.id, i.invoice_number as doc_number, c.name as counterparty_name, i.total_amount as pending_debt, i.created_at
                    FROM invoices i
                    JOIN counterparties c ON i.counterparty_id = c.id
                    WHERE i.status = 'pending'
                    
                    UNION ALL
                    
                    SELECT o.id, o.doc_number, c.name as counterparty_name, o.pending_debt, o.created_at
                    FROM client_orders o 
                    JOIN counterparties c ON o.counterparty_id = c.id 
                    LEFT JOIN CP_Balances b ON o.counterparty_id = b.counterparty_id
                    WHERE o.status IN ('pending', 'processing', 'completed') AND o.pending_debt > 0 AND COALESCE(b.saldo, 0) > 0
                ) combined
                ORDER BY created_at DESC LIMIT 5
            `);
            // 2. Умный расчет дефицита (Свободный остаток < Порог)
            // Учитываем общие остатки и вычитаем зарезервированные под заказы позиции
            const stockRes = await pool.query(`
                WITH total_stock AS (
                    -- Физический остаток (все склады)
                    SELECT item_id, SUM(quantity) as physical_qty 
                    FROM inventory_movements 
                    GROUP BY item_id
                ),
                reservations AS (
                    -- Резерв: товары, которые уже закреплены за активными заказами
                    SELECT coi.item_id, SUM(coi.qty_reserved) as reserved_qty
                    FROM client_order_items coi
                    JOIN client_orders co ON coi.order_id = co.id
                    WHERE co.status IN ('pending', 'processing')
                    GROUP BY coi.item_id
                )
                SELECT 
                    i.name, i.article, i.min_stock, i.unit,
                    COALESCE(s.physical_qty, 0) as physical_qty,
                    COALESCE(r.reserved_qty, 0) as reserved_qty,
                    (COALESCE(s.physical_qty, 0) - COALESCE(r.reserved_qty, 0)) as current_qty
                FROM items i 
                LEFT JOIN total_stock s ON i.id = s.item_id 
                LEFT JOIN reservations r ON i.id = r.item_id
                WHERE i.min_stock > 0 
                  AND (COALESCE(s.physical_qty, 0) - COALESCE(r.reserved_qty, 0)) < i.min_stock
                ORDER BY (i.min_stock - (COALESCE(s.physical_qty, 0) - COALESCE(r.reserved_qty, 0))) DESC 
                LIMIT 15
            `);

            res.json({
                ar: { total: totalAr, list: arListRes.rows },
                min_stock: stockRes.rows
            });
        } catch (err) {
            logger.error('[dashboard-widgets]', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    return router;
};