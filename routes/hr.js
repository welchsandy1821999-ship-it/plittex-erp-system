// === ФАЙЛ: routes/hr.js ===
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const Big = require('big.js');
const { requireAdmin } = require('../middleware/auth');
const { validateSalaryAdjustment, validateTimesheetCell, validateMassBonus, validateSalaryPay } = require('../middleware/validator');

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (Вне экспорта) ===

/**
 * Проверяет, заблокирован ли месяц для редактирования.
 * Используется для защиты данных от изменений "задним числом".
 */
async function isMonthClosed(pool, monthStr) {
    const res = await pool.query(
        'SELECT 1 FROM closed_periods WHERE period_str = $1 AND module = $2',
        [monthStr, 'salary']
    );
    return res.rows.length > 0;
}

// === ОСНОВНОЙ ЭКСПОРТ РОУТЕРА ===

module.exports = function (pool, withTransaction) {


    // 2. КОРРЕКТИРОВКИ (ГСМ, Займы)
    router.post('/api/salary/adjustments', requireAdmin, validateSalaryAdjustment, async (req, res) => {
        const { employee_id, month_str, amount, description } = req.body;
        try {
            // 🛡️ ЗАЩИТА №2: Не даем добавлять ГСМ/Займы в закрытый месяц
            if (await isMonthClosed(pool, month_str)) {
                return res.status(403).json({ error: "Нельзя добавлять операции в закрытый месяц." });
            }

            const safeAmount = new Big(amount || 0).toFixed(2);
            await pool.query(
                `INSERT INTO salary_adjustments (employee_id, month_str, amount, description) VALUES ($1, $2, $3, $4)`,
                [employee_id, month_str, safeAmount, description]
            );
            res.json({ success: true });
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    // ==========================================
    // 1. КОРРЕКТИРОВКИ (ГСМ, Займы, Штрафы)
    // ==========================================
    router.get('/api/salary/adjustments', async (req, res) => {
        try {
            const result = await pool.query(`SELECT * FROM salary_adjustments WHERE month_str = $1 AND COALESCE(is_deleted, false) = false`, [req.query.monthStr]);
            res.json(result.rows);
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    router.delete('/api/salary/adjustments/:id', requireAdmin, async (req, res) => {
        try {
            // 🛡️ ЗАЩИТА: Проверяем, не закрыт ли месяц перед удалением
            const adj = await pool.query('SELECT month_str FROM salary_adjustments WHERE id = $1', [req.params.id]);
            if (adj.rows.length > 0 && await isMonthClosed(pool, adj.rows[0].month_str)) {
                return res.status(403).json({ error: "Нельзя удалять операции из закрытого месяца." });
            }
            await pool.query(`UPDATE salary_adjustments SET is_deleted = true WHERE id = $1`, [req.params.id]);
            res.json({ success: true });
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    // ==========================================
    // 2. НАЛОГИ И СТАТИСТИКА
    // ==========================================
    router.get('/api/salary/stats', async (req, res) => {
        const { year, month } = req.query;
        const monthStr = `${year}-${month}`;
        try {
            await pool.query(`
                INSERT INTO monthly_salary_stats (employee_id, month_str, salary_cash, salary_official, tax_rate, tax_withheld) 
                SELECT id, $1, salary_cash, salary_official, tax_rate, tax_withheld FROM employees 
                ON CONFLICT (employee_id, month_str) DO NOTHING
            `, [monthStr]);
            const result = await pool.query(`SELECT * FROM monthly_salary_stats WHERE month_str = $1`, [monthStr]);
            res.json(result.rows);
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    // ==========================================
    // 3. ТАБЕЛЬ (TIMESHEET)
    // ==========================================
    router.get('/api/timesheet', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT e.id as employee_id, e.full_name, e.position, e.department, e.schedule_type, t.status 
                FROM employees e 
                LEFT JOIN timesheet_records t ON e.id = t.employee_id AND t.record_date = $1
                ORDER BY e.department, e.full_name
            `, [req.query.date]);
            res.json(result.rows);
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    router.get('/api/timesheet/month', async (req, res) => {
        const { year, month } = req.query;
        try {
            const startDate = `${year}-${month}-01`;
            const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
            const result = await pool.query(`
                SELECT employee_id, TO_CHAR(record_date, 'YYYY-MM-DD') as record_date, 
                       status, bonus, penalty, bonus_comment, penalty_comment, custom_rate, ktu, multiplier 
                FROM timesheet_records 
                WHERE record_date >= $1 AND record_date <= $2
            `, [startDate, endDate]);
            res.json(result.rows);
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    // ОБНОВЛЕННЫЙ РОУТ: Сохранение ячейки табеля
    router.post('/api/timesheet/cell', requireAdmin, validateTimesheetCell, async (req, res) => {
        const { employee_id, date, status, bonus, penalty, bonus_comment, penalty_comment, multiplier } = req.body;
        const monthStr = date.substring(0, 7);

        try {
            // 🛡️ ЗАЩИТА: Проверяем, не закрыт ли месяц
            if (await isMonthClosed(pool, monthStr)) {
                return res.status(403).json({ error: "Этот месяц уже закрыт для редактирования" });
            }

            // 🛡️ AUDIT-018: status whitelist, bonus/penalty/multiplier перенесены в validateTimesheetCell middleware

            // 🧲 Big.js конверсия (после валидации)
            const safeBonus = new Big(bonus || 0);
            const safePenalty = new Big(penalty || 0);

            let safeMultiplier = multiplier !== undefined ? parseFloat(multiplier) : 1.0;
            if (isNaN(safeMultiplier)) safeMultiplier = 1.0;

            await pool.query(`
            INSERT INTO timesheet_records (employee_id, record_date, status, bonus, penalty, bonus_comment, penalty_comment, multiplier)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (employee_id, record_date) 
            DO UPDATE SET status = EXCLUDED.status, 
                          bonus = EXCLUDED.bonus, 
                          penalty = EXCLUDED.penalty, 
                          bonus_comment = EXCLUDED.bonus_comment, 
                          penalty_comment = EXCLUDED.penalty_comment,
                          multiplier = EXCLUDED.multiplier
        `, [employee_id, date, status, safeBonus.toFixed(2), safePenalty.toFixed(2), bonus_comment || '', penalty_comment || '', safeMultiplier]);

            res.json({ success: true });
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    router.post('/api/timesheet', requireAdmin, async (req, res) => {
        const { date, records } = req.body;
        try {
            await withTransaction(pool, async (client) => {
                for (let rec of records) {
                    await client.query(`
                        INSERT INTO timesheet_records (employee_id, record_date, status) VALUES ($1, $2, $3) 
                        ON CONFLICT (employee_id, record_date) DO UPDATE SET status = EXCLUDED.status
                    `, [rec.employee_id, date, rec.status]);
                }
            });
            res.json({ success: true });
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    router.post('/api/timesheet/mass-bonus', requireAdmin, validateMassBonus, async (req, res) => {
        // 🚀 1. Принимаем только дату и список рабочих
        const { date, workersData } = req.body;
        const monthStr = date.substring(0, 7);

        try {
            if (await isMonthClosed(pool, monthStr)) {
                return res.status(403).json({ error: "Этот месяц уже закрыт. Начисление премий задним числом запрещено." });
            }

            await withTransaction(pool, async (client) => {
                // 🚀 2. УМНЫЙ ЗАПРОС: Считаем фонд по фактической дате производства (production_date)
                const prodRes = await client.query(`
                SELECT COALESCE(SUM(pb.actual_good_qty * COALESCE(i.piece_rate, 0)), 0) as total_fund
                FROM production_batches pb
                LEFT JOIN items i ON pb.product_id = i.id
                WHERE pb.production_date = $1 AND pb.status = 'completed'
            `, [date]);

                let totalFund = Math.round(parseFloat(prodRes.rows[0].total_fund) || 0);
                let totalKtu = 0;
                let validWorkers = [];

                // 🛡️ AUDIT-018: проверка ktu 0-5 перенесена в validateMassBonus middleware
                for (let w of (workersData || [])) {
                    const k = parseFloat(w.ktu) || 0;
                    totalKtu += k;
                    validWorkers.push({ id: w.employee_id, ktu: k, custom_rate: parseFloat(w.custom_rate) || 0, bonus: 0 });
                }

                let distributedAmount = 0;
                if (totalKtu > 0 && totalFund > 0) {
                    for (let i = 0; i < validWorkers.length; i++) {
                        const bonus = Math.round(totalFund * (validWorkers[i].ktu / totalKtu));
                        validWorkers[i].bonus = bonus;
                        distributedAmount += bonus;
                    }

                    // Раскидываем копейки (твой алгоритм)
                    const diff = totalFund - distributedAmount;
                    if (diff !== 0 && validWorkers.length > 0) {
                        validWorkers[0].bonus += diff;
                    }
                }

                for (let emp of validWorkers) {
                    const b = new Big(emp.bonus).toFixed(2);
                    const k = new Big(emp.ktu).toFixed(2);
                    const r = emp.custom_rate ? new Big(emp.custom_rate).toFixed(2) : null;

                    await client.query(`
                    INSERT INTO timesheet_records (employee_id, record_date, status, bonus, custom_rate, ktu) 
                    VALUES ($1, $2, 'present', $3, $4, $5) 
                    ON CONFLICT (employee_id, record_date) 
                    DO UPDATE SET bonus = EXCLUDED.bonus, custom_rate = EXCLUDED.custom_rate, ktu = EXCLUDED.ktu
                `, [emp.id, date, b, r, k]);
                }

                // 🚀 3. Помечаем партии как «рассчитанные» также по производственной дате
                await client.query(`
                UPDATE production_batches 
                SET is_salary_calculated = true 
                WHERE production_date = $1
            `, [date]);
            });
            res.json({ success: true });
        } catch (err) {
            logger.error('Ошибка массовой премии:', err.message);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    // ==========================================
    // 4. ВЫПЛАТЫ (PAYMENTS)
    // ==========================================
    router.get('/api/salary/payments', async (req, res) => {
        const { year, month } = req.query;
        try {
            const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
            const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;

            const result = await pool.query(`
                SELECT id, employee_id, amount, TO_CHAR(payment_date, 'YYYY-MM-DD') as payment_date, description 
                FROM salary_payments 
                WHERE payment_date >= $1 AND payment_date <= $2 AND COALESCE(is_deleted, false) = false
                ORDER BY payment_date ASC
            `, [startDate, endDate]);
            res.json(result.rows);
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    router.post('/api/salary/pay', requireAdmin, validateSalaryPay, async (req, res) => {
        const { employee_id, amount, date, description, account_id, imprest_deduction } = req.body;
        const monthStr = date.substring(0, 7);

        try {
            // 🛡️ ЗАЩИТА: Проверяем, не закрыт ли месяц
            if (await isMonthClosed(pool, monthStr)) {
                return res.status(403).json({ error: "Этот месяц уже закрыт. Проводить выплаты этим числом нельзя." });
            }

            // 🛡️ AUDIT-018: проверка amount < 0 перенесена в validateSalaryPay middleware
            const payAmount = new Big(amount || 0);
            const amountStr = payAmount.toFixed(2);
            const deductionAmount = new Big(imprest_deduction || 0);

            await withTransaction(pool, async (client) => {
                // 1. Получаем данные счета, включая его ТИП (тип нужен для payment_method)
                const accRes = await client.query('SELECT balance, name, type FROM accounts WHERE id = $1 FOR UPDATE', [account_id]);
                if (accRes.rows.length === 0) throw new Error('Счет не найден');

                if (payAmount.gt(0) && new Big(accRes.rows[0].balance).lt(payAmount)) {
                    throw new Error(`Недостаточно средств на счете "${accRes.rows[0].name}"`);
                }

                // ОПРЕДЕЛЯЕМ СПОСОБ ОПЛАТЫ ДЛЯ ТРАНЗАКЦИИ
                const paymentMethod = accRes.rows[0].type === 'cash' ? 'Наличные (Касса)' : 'Безналичный расчет';

                let linkedTransactionId = null;

                // Находим контрагента для акта сверки
                const cpRes = await client.query('SELECT id FROM counterparties WHERE employee_id = $1 LIMIT 1', [employee_id]);
                const counterparty_id = cpRes.rows.length > 0 ? cpRes.rows[0].id : null;

                // 2. Списываем из кассы (только если сумма > 0)
                if (payAmount.gt(0)) {
                    const transRes = await client.query(`
                        INSERT INTO transactions (account_id, counterparty_id, amount, transaction_type, category, description, payment_method, source_module, transaction_date) 
                        VALUES ($1, $2, $3, 'expense', 'Зарплата', $4, $5, 'salary', $6) RETURNING id
                    `, [account_id, counterparty_id, amountStr, `Выплата сотруднику: ${description}`, paymentMethod, date + ' 12:00:00']);
                    linkedTransactionId = transRes.rows[0].id;
                }

                // 3. Если есть удержание подотчета - гасим виртуальный счет
                if (deductionAmount.gt(0)) {
                    const empRes = await client.query('SELECT full_name FROM employees WHERE id = $1', [employee_id]);
                    const empName = empRes.rows[0]?.full_name || 'Сотрудник';

                    await client.query(`
                        INSERT INTO transactions (account_id, amount, transaction_type, category, description, payment_method, source_module, transaction_date)
                        VALUES ((SELECT id FROM accounts WHERE employee_id = $1 AND type = 'imprest'), $2, 'expense', 'Удержание из ЗП', 'Автоматическое погашение подотчета', 'Взаимозачет', 'salary', $3)
                    `, [employee_id, deductionAmount.toFixed(2), date + ' 12:01:00']);
                }

                // 4. Записываем факт выплаты в зарплатную таблицу (полная сумма: руки + удержание)
                const totalCleared = payAmount.plus(deductionAmount).toFixed(2);
                await client.query(`
                    INSERT INTO salary_payments (employee_id, amount, payment_date, description, account_id, linked_transaction_id) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [employee_id, totalCleared, date, description, account_id, linkedTransactionId]);
            });

            res.json({ success: true });
        } catch (err) {
            logger.error('Ошибка выплаты:', err.message);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    router.delete('/api/salary/payment/:id', requireAdmin, async (req, res) => {
        try {
            await withTransaction(pool, async (client) => {
                const payRes = await client.query('SELECT * FROM salary_payments WHERE id = $1', [req.params.id]);
                if (payRes.rows.length === 0) throw new Error('Выплата не найдена');

                const payment = payRes.rows[0];

                // 🛡️ ЗАЩИТА: Нельзя удалять выплаты из закрытого месяца
                const payMonthStr = payment.payment_date.toISOString().substring(0, 7);
                if (await isMonthClosed(pool, payMonthStr)) {
                    throw new Error('Нельзя удалять выплаты из закрытого месяца.');
                }

                // Если есть связь с транзакцией - удаляем её.
                // 🚀 МАГИЯ ТРИГГЕРА: При удалении этой транзакции деньги сами вернутся на баланс счета!
                if (payment.linked_transaction_id) {
                    await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [payment.linked_transaction_id]);
                }

                // Удаляем запись о выплате (Soft Delete)
                await client.query('UPDATE salary_payments SET is_deleted = true WHERE id = $1', [req.params.id]);
            });
            res.json({ success: true });
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    // ==================================================================
    // 5. ЗАКРЫТИЕ ПЕРИОДА И ТЕХНИЧЕСКИЕ РОУТЫ
    // ==================================================================

    // ОБНОВЛЕННЫЙ РОУТ: Получение выплат (улучшен сбор балансов)
    router.get('/api/salary/balances', async (req, res) => {
        const { year, month } = req.query;
        const monthStr = `${year}-${month}`;
        try {
            // Запрос, который учитывает и активных, и уволенных, у которых есть долги/остатки
            const result = await pool.query(`
            SELECT e.id, e.full_name, e.prev_balance, e.status, e.department,
                   COALESCE(a.balance, 0) AS imprest_debt 
            FROM employees e
            LEFT JOIN accounts a ON a.employee_id = e.id AND a.type = 'imprest'
            WHERE e.status = 'active' 
               OR e.prev_balance != 0 
               OR EXISTS (SELECT 1 FROM timesheet_records WHERE employee_id = e.id AND record_date >= $1::date AND record_date < ($1::date + interval '1 month'))
        `, [monthStr + '-01']);
            res.json(result.rows);
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    // ==========================================
    // НОВЫЙ РОУТ: Проверка статуса месяца и сохраненных налогов
    // ==========================================
    router.get('/api/salary/is-closed', async (req, res) => {
        try {
            const check = await pool.query('SELECT * FROM closed_periods WHERE period_str = $1 AND module = $2', [req.query.monthStr, 'salary']);
            if (check.rows.length > 0) {
                res.json({ isClosed: true, total_taxes: check.rows[0].total_taxes });
            } else {
                res.json({ isClosed: false });
            }
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    // ==========================================
    // ОБНОВЛЕННЫЙ РОУТ: Закрытие месяца (Идеальная синхронизация)
    // ==========================================
    router.post('/api/salary/close-month', requireAdmin, async (req, res) => {
        // Принимаем месяц, точные остатки и введенные налоги
        const { monthStr, balances, totalTaxes } = req.body;

        if (!/^\d{4}-\d{2}$/.test(monthStr)) {
            return res.status(400).json({ error: 'Неверный формат месяца' });
        }

        try {
            await withTransaction(pool, async (client) => {
                // Проверяем, не закрыт ли месяц дважды
                const check = await client.query('SELECT 1 FROM closed_periods WHERE period_str = $1 AND module = $2', [monthStr, 'salary']);
                if (check.rows.length > 0) throw new Error('Этот месяц уже закрыт.');

                // Обновляем долг/переплату для КАЖДОГО сотрудника по точным данным с фронтенда
                for (let b of balances) {
                    await client.query(`UPDATE employees SET prev_balance = $1 WHERE id = $2`, [b.balance, b.employee_id]);

                    // Интеграция с Финансами: Формируем "Начисление ЗП" (Обязательство)
                    if (b.accrued && parseFloat(b.accrued) > 0) {
                        const cpRes = await client.query('SELECT id FROM counterparties WHERE employee_id = $1 LIMIT 1', [b.employee_id]);
                        if (cpRes.rows.length > 0) {
                            const cpId = cpRes.rows[0].id;
                            await client.query(`
                                INSERT INTO transactions 
                                (amount, transaction_type, category, description, counterparty_id, account_id, payment_method, transaction_date)
                                VALUES ($1, 'income', 'Начисление ЗП', $2, $3, NULL, 'Взаимозачет', NOW())
                            `, [b.accrued, 'Начислено за период: ' + monthStr, cpId]);
                        }
                    }
                }

                // Записываем месяц в архив и фиксируем сумму налогов
                await client.query(
                    'INSERT INTO closed_periods (period_str, module, total_taxes) VALUES ($1, $2, $3)',
                    [monthStr, 'salary', totalTaxes || 0]
                );
            });

            res.json({ success: true, message: `Месяц закрыт. Балансы перенесены.` });
        } catch (err) {
            logger.error('Ошибка закрытия:', err.message);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    // ==========================================
    // НОВЫЙ РОУТ: Открытие закрытого месяца (Откат балансов)
    // ==========================================
    router.post('/api/salary/reopen-month', requireAdmin, async (req, res) => {
        const { monthStr, balances } = req.body;

        if (!/^\d{4}-\d{2}$/.test(monthStr)) {
            return res.status(400).json({ error: 'Неверный формат месяца' });
        }

        try {
            await withTransaction(pool, async (client) => {
                // Проверяем, закрыт ли месяц на самом деле
                const check = await client.query('SELECT 1 FROM closed_periods WHERE period_str = $1 AND module = $2', [monthStr, 'salary']);
                if (check.rows.length === 0) throw new Error('Этот месяц не закрыт или уже был открыт.');

                // А) Математический возврат баланса (Откатываем изменения, вычитая net_change этого месяца)
                // Для каждого сотрудника из массива восстанавливаем старый баланс
                for (let b of balances) {
                    if (b.net_change !== undefined) {
                        await client.query(`UPDATE employees SET prev_balance = prev_balance - $1 WHERE id = $2`, [b.net_change, b.employee_id]);
                    }
                }

                // Б) Удаление сгенерированных автоматических транзакций
                // Описание у нас жестко фиксировано: "Начислено за период: YYYY-MM"
                await client.query(`
                    DELETE FROM transactions 
                    WHERE category = 'Начисление ЗП' 
                      AND description LIKE $1
                `, [`Начислено за период: ${monthStr}%`]);

                // В) Удаление блокировок из архива закрытых периодов
                await client.query(`DELETE FROM closed_periods WHERE period_str = $1 AND module = 'salary'`, [monthStr]);
            });

            res.json({ success: true, message: `Месяц ${monthStr} открыт. Балансы успешно откачены.` });
        } catch (err) {
            logger.error('Ошибка отмены закрытия:', err.message);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    router.get('/api/production/daily-stats', async (req, res) => {
        const { date } = req.query;
        try {
            const result = await pool.query(`
                SELECT 
                    COALESCE(SUM(pb.actual_good_qty), 0) as total_good,
                    COALESCE(SUM(pb.actual_good_qty * COALESCE(i.piece_rate, 0)), 0) as total_fund
                FROM production_batches pb
                LEFT JOIN items i ON pb.product_id = i.id
                WHERE pb.production_date = $1 AND pb.status = 'completed'
            `, [date]); // 🚀 Заменили created_at::date на production_date

            res.json({
                total: result.rows[0].total_good,
                fund: result.rows[0].total_fund
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });



    return router;
};