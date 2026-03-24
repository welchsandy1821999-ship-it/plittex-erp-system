// === ФАЙЛ: routes/hr.js ===
const express = require('express');
const router = express.Router();
const Big = require('big.js');
const { requireAdmin } = require('../middleware/auth');

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

    // 1. СОХРАНЕНИЕ ЯЧЕЙКИ ТАБЕЛЯ (С проверкой безопасности)
    router.post('/api/timesheet/cell', async (req, res) => {
        const { employee_id, date, status, bonus, penalty, bonus_comment, penalty_comment } = req.body;
        const monthStr = date.substring(0, 7); // Извлекаем YYYY-MM

        try {
            // 🛡️ ЗАЩИТА №1: Проверка закрытого периода
            if (await isMonthClosed(pool, monthStr)) {
                return res.status(403).json({ error: "Этот месяц уже закрыт. Редактирование запрещено." });
            }

            // 🧮 ТОЧНОСТЬ №1: Используем Big.js для финансовых полей
            const safeBonus = new Big(bonus || 0).toFixed(2);
            const safePenalty = new Big(penalty || 0).toFixed(2);

            await pool.query(`
                INSERT INTO timesheet_records (employee_id, record_date, status, bonus, penalty, bonus_comment, penalty_comment)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (employee_id, record_date) 
                DO UPDATE SET status = EXCLUDED.status, 
                              bonus = EXCLUDED.bonus, 
                              penalty = EXCLUDED.penalty, 
                              bonus_comment = EXCLUDED.bonus_comment, 
                              penalty_comment = EXCLUDED.penalty_comment
            `, [employee_id, date, status, safeBonus, safePenalty, bonus_comment || '', penalty_comment || '']);

            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 2. КОРРЕКТИРОВКИ (ГСМ, Займы)
    router.post('/api/salary/adjustments', async (req, res) => {
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
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ==========================================
    // 1. КОРРЕКТИРОВКИ (ГСМ, Займы, Штрафы)
    // ==========================================
    router.get('/api/salary/adjustments', async (req, res) => {
        try {
            const result = await pool.query(`SELECT * FROM salary_adjustments WHERE month_str = $1`, [req.query.monthStr]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete('/api/salary/adjustments/:id', requireAdmin, async (req, res) => {
        try {
            await pool.query(`DELETE FROM salary_adjustments WHERE id = $1`, [req.params.id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
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
        } catch (err) { res.status(500).json({ error: err.message }); }
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
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/timesheet/month', async (req, res) => {
        const { year, month } = req.query;
        try {
            const startDate = `${year}-${month}-01`;
            const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
            const result = await pool.query(`
                SELECT employee_id, TO_CHAR(record_date, 'YYYY-MM-DD') as record_date, 
                       status, bonus, penalty, bonus_comment, penalty_comment, custom_rate, ktu 
                FROM timesheet_records 
                WHERE record_date >= $1 AND record_date <= $2
            `, [startDate, endDate]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ОБНОВЛЕННЫЙ РОУТ: Сохранение ячейки табеля
    router.post('/api/timesheet/cell', async (req, res) => {
        const { employee_id, date, status, bonus, penalty, bonus_comment, penalty_comment } = req.body;
        const monthStr = date.substring(0, 7); // Получаем YYYY-MM из даты

        try {
            // 🛡️ ЗАЩИТА: Проверяем, не закрыт ли месяц
            if (await isMonthClosed(pool, monthStr)) {
                return res.status(403).json({ error: "Этот месяц уже закрыт для редактирования" });
            }

            // 🧮 ВАЛИДАЦИЯ: Гарантируем точность чисел через Big.js
            const safeBonus = new Big(bonus || 0).toFixed(2);
            const safePenalty = new Big(penalty || 0).toFixed(2);

            await pool.query(`
            INSERT INTO timesheet_records (employee_id, record_date, status, bonus, penalty, bonus_comment, penalty_comment)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (employee_id, record_date) 
            DO UPDATE SET status = EXCLUDED.status, 
                          bonus = EXCLUDED.bonus, 
                          penalty = EXCLUDED.penalty, 
                          bonus_comment = EXCLUDED.bonus_comment, 
                          penalty_comment = EXCLUDED.penalty_comment
        `, [employee_id, date, status, safeBonus, safePenalty, bonus_comment || '', penalty_comment || '']);

            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/timesheet', async (req, res) => {
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
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/timesheet/mass-bonus', requireAdmin, async (req, res) => {
        const { date, pieceRate, workersData } = req.body;
        const monthStr = date.substring(0, 7);

        try {
            if (await isMonthClosed(pool, monthStr)) {
                return res.status(403).json({ error: "Этот месяц уже закрыт. Начисление премий задним числом запрещено." });
            }

            const safePieceRate = parseFloat(pieceRate) || 0;
            if (safePieceRate < 0 || safePieceRate > 10000) {
                 return res.status(400).json({ error: "Недопустимая расценка: должна быть от 0 до 10000 ₽" });
            }

            await withTransaction(pool, async (client) => {
                const prodRes = await client.query(`
                    SELECT SUM(actual_good_qty) as total_good 
                    FROM production_batches 
                    WHERE created_at::date = $1 AND status = 'completed'
                `, [date]);
                
                const actualTotalGood = parseFloat(prodRes.rows[0].total_good) || 0;
                let totalFund = Math.round(actualTotalGood * safePieceRate);
                let totalKtu = 0;
                let validWorkers = [];

                for (let w of (workersData || [])) {
                    const k = parseFloat(w.ktu) || 0;
                    if (k < 0 || k > 5) throw new Error("КТУ должно быть от 0 до 5");
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
                
                await client.query(`UPDATE production_batches SET is_salary_calculated = true WHERE created_at::date = $1`, [date]);
            });
            res.json({ success: true });
        } catch (err) { 
            console.error('Ошибка массовой премии:', err.message);
            res.status(500).json({ error: err.message }); 
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
                WHERE payment_date >= $1 AND payment_date <= $2 
                ORDER BY payment_date ASC
            `, [startDate, endDate]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/salary/pay', requireAdmin, async (req, res) => {
        const { employee_id, amount, date, description, account_id } = req.body;
        const monthStr = date.substring(0, 7); // Извлекаем YYYY-MM из даты выплаты

        try {
            // 🛡️ ЗАЩИТА: Проверяем, не закрыт ли месяц
            if (await isMonthClosed(pool, monthStr)) {
                return res.status(403).json({ error: "Этот месяц уже закрыт. Проводить выплаты этим числом нельзя." });
            }

            const payAmount = new Big(amount || 0);
            if (payAmount.lte(0)) throw new Error('Сумма должна быть больше нуля');
            const amountStr = payAmount.toFixed(2);

            await withTransaction(pool, async (client) => {
                // 1. Получаем данные счета, включая его ТИП (тип нужен для payment_method)
                const accRes = await client.query('SELECT balance, name, type FROM accounts WHERE id = $1 FOR UPDATE', [account_id]);
                if (accRes.rows.length === 0) throw new Error('Счет не найден');

                if (new Big(accRes.rows[0].balance).lt(payAmount)) {
                    throw new Error(`Недостаточно средств на счете "${accRes.rows[0].name}"`);
                }

                // ОПРЕДЕЛЯЕМ СПОСОБ ОПЛАТЫ ДЛЯ ТРАНЗАКЦИИ
                const paymentMethod = accRes.rows[0].type === 'cash' ? 'Наличные (Касса)' : 'Безналичный расчет';

                // 2. Списываем из кассы
                const transRes = await client.query(`
                    INSERT INTO transactions (account_id, amount, transaction_type, category, description, payment_method, source_module, transaction_date) 
                    VALUES ($1, $2, 'expense', 'Зарплата и Авансы', $3, $4, 'salary', $5) RETURNING id
                `, [account_id, amountStr, `Выплата сотруднику: ${description}`, paymentMethod, date + ' 12:00:00']);
                // 3. Записываем факт выплаты в зарплатную таблицу
                await client.query(`
                    INSERT INTO salary_payments (employee_id, amount, payment_date, description, account_id, linked_transaction_id) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [employee_id, amountStr, date, description, account_id, transRes.rows[0].id]);
            });

            res.json({ success: true });
        } catch (err) {
            console.error('Ошибка выплаты:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/api/salary/payment/:id', requireAdmin, async (req, res) => {
        try {
            await withTransaction(pool, async (client) => {
                const payRes = await client.query('SELECT * FROM salary_payments WHERE id = $1', [req.params.id]);
                if (payRes.rows.length === 0) throw new Error('Выплата не найдена');

                const payment = payRes.rows[0];

                // Если есть связь с транзакцией - удаляем её.
                // 🚀 МАГИЯ ТРИГГЕРА: При удалении этой транзакции деньги сами вернутся на баланс счета!
                if (payment.linked_transaction_id) {
                    await client.query('DELETE FROM transactions WHERE id = $1', [payment.linked_transaction_id]);
                }

                // Удаляем запись о выплате
                await client.query('DELETE FROM salary_payments WHERE id = $1', [req.params.id]);
            });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
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
            SELECT e.id, e.full_name, e.prev_balance, e.status, e.department
            FROM employees e
            WHERE e.status = 'active' 
               OR e.prev_balance != 0 
               OR EXISTS (SELECT 1 FROM timesheet_records WHERE employee_id = e.id AND TO_CHAR(record_date, 'YYYY-MM') = $1)
        `, [monthStr]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
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
        } catch (err) { res.status(500).json({ error: err.message }); }
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
                    await client.query(`UPDATE employees SET prev_balance = $1 WHERE id = $2`, [b.balance, b.empId]);
                }

                // Записываем месяц в архив и фиксируем сумму налогов
                await client.query(
                    'INSERT INTO closed_periods (period_str, module, total_taxes) VALUES ($1, $2, $3)',
                    [monthStr, 'salary', totalTaxes || 0]
                );
            });

            res.json({ success: true, message: `Месяц закрыт. Балансы перенесены.` });
        } catch (err) {
            console.error('Ошибка закрытия:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/api/production/daily-stats', async (req, res) => {
        const { date } = req.query;
        try {
            const result = await pool.query(`
                SELECT SUM(actual_good_qty) as total_good 
                FROM production_batches 
                WHERE created_at::date = $1 AND status = 'completed'
            `, [date]);

            res.json({ total: result.rows[0].total_good || 0 });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });



    return router;
};