const express = require('express');
const router = express.Router();

module.exports = function(pool) {
    router.get('/api/salary/adjustments', async (req, res) => {
        try {
            const result = await pool.query(`SELECT * FROM salary_adjustments WHERE month_str = $1`, [req.query.monthStr]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/salary/adjustments', async (req, res) => {
        const { employee_id, month_str, amount, description } = req.body;
        try {
            await pool.query(`INSERT INTO salary_adjustments (employee_id, month_str, amount, description) VALUES ($1, $2, $3, $4)`, [employee_id, month_str, amount, description]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete('/api/salary/adjustments/:id', async (req, res) => {
        try {
            await pool.query(`DELETE FROM salary_adjustments WHERE id = $1`, [req.params.id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/salary/stats', async (req, res) => {
        const { year, month } = req.query;
        const monthStr = `${year}-${month}`;
        try {
            await pool.query(`INSERT INTO monthly_salary_stats (employee_id, month_str, salary_cash, salary_official, tax_rate, tax_withheld) SELECT id, $1, salary_cash, salary_official, tax_rate, tax_withheld FROM employees ON CONFLICT (employee_id, month_str) DO NOTHING`, [monthStr]);
            const result = await pool.query(`SELECT * FROM monthly_salary_stats WHERE month_str = $1`, [monthStr]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/salary/pay-taxes', async (req, res) => {
        const { monthStr, amount } = req.body;
        try {
            await pool.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method) VALUES ($1, 'expense', 'Налоги и Взносы', $2, 0, 'Безналичный расчет')`, [amount, `Уплата налогов с ФОТ за ${monthStr}`]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/timesheet', async (req, res) => {
        try {
            const result = await pool.query(`SELECT e.id as employee_id, e.full_name, e.position, e.department, e.schedule_type, t.status FROM employees e LEFT JOIN timesheets t ON e.id = t.employee_id AND t.record_date = $1 ORDER BY e.department, e.full_name`, [req.query.date]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/timesheet', async (req, res) => {
        const { date, records } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (let rec of records) {
                await client.query(`INSERT INTO timesheets (employee_id, record_date, status) VALUES ($1, $2, $3) ON CONFLICT (employee_id, record_date) DO UPDATE SET status = EXCLUDED.status`, [rec.employee_id, date, rec.status]);
            }
            await client.query('COMMIT');
            res.json({ success: true, message: 'Табель сохранен' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    router.get('/api/timesheet/month', async (req, res) => {
        const { year, month } = req.query;
        try {
            const startDate = `${year}-${month}-01`;
            const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
            const result = await pool.query(`SELECT employee_id, TO_CHAR(record_date, 'YYYY-MM-DD') as record_date, status, bonus, penalty, custom_rate, ktu FROM timesheets WHERE record_date >= $1 AND record_date <= $2`, [startDate, endDate]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/timesheet/cell', async (req, res) => {
        const { employee_id, date, status, bonus, penalty } = req.body;
        try {
            await pool.query(`INSERT INTO timesheets (employee_id, record_date, status, bonus, penalty) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (employee_id, record_date) DO UPDATE SET status = EXCLUDED.status, bonus = EXCLUDED.bonus, penalty = EXCLUDED.penalty`, [employee_id, date, status, bonus || 0, penalty || 0]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/production/daily-stats', async (req, res) => {
        try {
            const result = await pool.query(`SELECT SUM(actual_good_qty) as total_good FROM production_batches WHERE created_at::date = $1 AND status = 'completed'`, [req.query.date]);
            res.json({ total: result.rows[0].total_good || 0 });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/timesheet/mass-bonus', async (req, res) => {
        const { date, empData, totalBonusFund } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (let emp of empData) {
                await client.query(`INSERT INTO timesheets (employee_id, record_date, status, bonus, custom_rate, ktu) VALUES ($1, $2, 'present', $3, $4, $5) ON CONFLICT (employee_id, record_date) DO UPDATE SET bonus = timesheets.bonus + EXCLUDED.bonus, custom_rate = EXCLUDED.custom_rate, ktu = EXCLUDED.ktu`, [emp.id, date, emp.bonus, emp.custom_rate, emp.ktu]);
            }
            if (totalBonusFund > 0) {
                const batchesRes = await client.query(`SELECT id, planned_quantity FROM production_batches WHERE created_at::date = $1`, [date]);
                const batches = batchesRes.rows;
                const totalProductsToday = batches.reduce((sum, b) => sum + parseFloat(b.planned_quantity), 0);
                if (totalProductsToday > 0) {
                    for (let batch of batches) {
                        const fraction = parseFloat(batch.planned_quantity) / totalProductsToday;
                        await client.query(`UPDATE production_batches SET labor_cost_total = COALESCE(labor_cost_total, 0) + $1 WHERE id = $2`, [totalBonusFund * fraction, batch.id]);
                    }
                }
            }
            await client.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    router.get('/api/salary/payments', async (req, res) => {
        const { year, month } = req.query;
        try {
            const startDate = `${year}-${month}-01`;
            const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
            const result = await pool.query(`SELECT id, employee_id, amount, TO_CHAR(payment_date, 'YYYY-MM-DD') as payment_date, description FROM salary_payments WHERE payment_date >= $1 AND payment_date <= $2 ORDER BY payment_date ASC`, [startDate, endDate]);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/salary/pay', async (req, res) => {
        const { employee_id, amount, date, description, account_id } = req.body;
        // 🛡️ ПАТЧ БЕЗОПАСНОСТИ: Запрещаем отрицательные авансы
        if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Сумма выплаты должна быть больше нуля!' });
        
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const transRes = await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method, account_id) VALUES ($1, 'expense', 'Зарплата и Авансы', $2, 0, 'Выплата из системы', $3) RETURNING id`, [amount, `Выплата: ${description}`, account_id]);
            const linkedId = transRes.rows[0].id;
            await client.query(`INSERT INTO salary_payments (employee_id, amount, payment_date, description, account_id, linked_transaction_id) VALUES ($1, $2, $3, $4, $5, $6)`, [employee_id, amount, date, description, account_id, linkedId]);
            await client.query(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [amount, account_id]);
            await client.query('COMMIT');
            res.json({ success: true, message: 'Выплата сохранена' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    router.delete('/api/salary/payment/:id', async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const payRes = await client.query('SELECT * FROM salary_payments WHERE id = $1', [req.params.id]);
            if (payRes.rows.length === 0) throw new Error('Выплата не найдена');
            const payment = payRes.rows[0];

            if (payment.linked_transaction_id) {
                const transRes = await client.query('SELECT amount, transaction_type, account_id FROM transactions WHERE id = $1', [payment.linked_transaction_id]);
                if (transRes.rows.length > 0) {
                    const trans = transRes.rows[0];
                    if (trans.account_id) {
                        const balanceChange = trans.transaction_type === 'income' ? -trans.amount : trans.amount;
                        await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, trans.account_id]);
                    }
                    await client.query('DELETE FROM transactions WHERE id = $1', [payment.linked_transaction_id]);
                }
            }
            await client.query('DELETE FROM salary_payments WHERE id = $1', [req.params.id]);
            await client.query('COMMIT');
            res.json({ success: true, message: 'Выплата удалена' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    router.post('/api/salary/close-month', async (req, res) => {
        const { balances } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (let b of balances) await client.query('UPDATE employees SET prev_balance = $1 WHERE id = $2', [b.balance, b.empId]);
            await client.query('COMMIT');
            res.json({ success: true, message: 'Месяц закрыт' });
        } catch (err) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: err.message });
        } finally { client.release(); }
    });

    return router;
};