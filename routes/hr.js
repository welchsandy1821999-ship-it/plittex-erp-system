// === ФАЙЛ: routes/hr.js ===
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const Big = require('big.js');
const crypto = require('crypto');
const { requireAdmin } = require('../middleware/auth');
const { validateSalaryAdjustment, validateTimesheetCell, validateMassBonus, validateSalaryPay } = require('../middleware/validator');
const { auditLog } = require('../utils/db_init');
const { recalcAccountBalances } = require('../utils/accountBalances');

/** Статья ДДС для выплат из «Кадры» — должна совпадать с `transaction_categories` (SSoT), иначе снова появится «дикая» статья. */
const HR_SALARY_EXPENSE_CATEGORY = 'Зарплата и Авансы';

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

async function resolveEmployeeFinanceLinks(client, employeeId) {
    const cpRes = await client.query(
        'SELECT id FROM counterparties WHERE employee_id = $1 AND COALESCE(is_deleted, false) = false LIMIT 1',
        [employeeId]
    );
    const counterpartyId = cpRes.rows[0]?.id || null;

    const accRes = await client.query(
        `SELECT id FROM accounts
         WHERE employee_id = $1
           AND (account_role = 'imprest' OR type = 'imprest')
         ORDER BY id ASC
         LIMIT 1`,
        [employeeId]
    );
    const imprestAccountId = accRes.rows[0]?.id || null;
    return { counterpartyId, imprestAccountId };
}

// === ОСНОВНОЙ ЭКСПОРТ РОУТЕРА ===

module.exports = function (pool, withTransaction) {
    // recalcAccountBalances импортирован из utils/accountBalances.js


    // 2. КОРРЕКТИРОВКИ (ГСМ, Займы)
    router.post('/api/salary/adjustments', requireAdmin, validateSalaryAdjustment, async (req, res) => {
        const {
            employee_id,
            month_str,
            amount,
            category,
            description,
            date,
            transaction_date,
            account_id,
            counterparty_id,
            cash_posting_mode,
            cash_account_id,
            operation_kind
        } = req.body || {};
        try {
            const explicitDateForMonth = String(transaction_date || date || '').trim();
            const effectiveMonthStr = String(month_str || '').trim() || (explicitDateForMonth ? explicitDateForMonth.slice(0, 7) : '');
            // 🛡️ ЗАЩИТА №2: Не даем добавлять ГСМ/Займы в закрытый месяц
            if (effectiveMonthStr && await isMonthClosed(pool, effectiveMonthStr)) {
                return res.status(403).json({ error: "Нельзя добавлять операции в закрытый месяц." });
            }

            const safeAmount = new Big(amount || 0).toFixed(2);
            const explicitDate = explicitDateForMonth;
            const normalizedMonthStr = effectiveMonthStr;
            const safeCategory = String(category || '').trim().substring(0, 255);
            const effectiveDate = explicitDate
                ? new Date(explicitDate).toISOString()
                : (normalizedMonthStr ? new Date(`${normalizedMonthStr}-01T12:00:00`).toISOString() : new Date().toISOString());
            let postingMode = ['none', 'cash', 'bank', 'imprest'].includes(String(cash_posting_mode || '').toLowerCase())
                ? String(cash_posting_mode || '').toLowerCase()
                : 'none';
            const opKind = String(operation_kind || 'manual_correction').trim().substring(0, 32) || 'manual_correction';
            const srcModule = 'salary';

            await withTransaction(pool, async (client) => {
                const links = await resolveEmployeeFinanceLinks(client, employee_id);
                const cpId = counterparty_id || links.counterpartyId || null;
                if (!cpId) {
                    throw new Error('Для сотрудника не найден связанный контрагент (counterparty_id).');
                }
                const effectiveDescription = safeCategory ? `${safeCategory}: ${description}` : description;
                let cashAccId = null;
                if (postingMode !== 'none') {
                    cashAccId = cash_account_id || account_id || null;
                }
                if (postingMode !== 'none' && !cashAccId) {
                    const defAccRes = await client.query(
                        `SELECT id, type
                         FROM accounts
                         WHERE type IN ('cash', 'bank')
                         ORDER BY CASE WHEN type = 'cash' THEN 0 ELSE 1 END, id ASC
                         LIMIT 1`
                    );
                    if (defAccRes.rows.length > 0) {
                        cashAccId = defAccRes.rows[0].id;
                    }
                }
                if (postingMode === 'none') {
                    cashAccId = null;
                }

                const catColRes = await client.query(
                    `SELECT 1
                     FROM information_schema.columns
                     WHERE table_schema = 'public'
                       AND table_name = 'salary_adjustments'
                       AND column_name = 'category'
                     LIMIT 1`
                );
                const hasAdjCategory = catColRes.rows.length > 0;
                const insAdj = hasAdjCategory
                    ? await client.query(
                        `INSERT INTO salary_adjustments
                            (employee_id, month_str, amount, category, description, counterparty_id, linked_transaction_id, cash_posting_mode, cash_account_id, operation_kind, source_module)
                         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10)
                         RETURNING id`,
                        [employee_id, normalizedMonthStr, safeAmount, safeCategory || null, description, cpId, postingMode, cashAccId, opKind, srcModule]
                    )
                    : await client.query(
                        `INSERT INTO salary_adjustments
                            (employee_id, month_str, amount, description, counterparty_id, linked_transaction_id, cash_posting_mode, cash_account_id, operation_kind, source_module)
                         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9)
                         RETURNING id`,
                        [employee_id, normalizedMonthStr, safeAmount, effectiveDescription, cpId, postingMode, cashAccId, opKind, srcModule]
                    );
                const adjustmentId = insAdj.rows[0].id;

                const amountBig = new Big(safeAmount);
                if (amountBig.eq(0)) return;

                let accType = null;
                if (cashAccId) {
                    const accRes = await client.query('SELECT id, type FROM accounts WHERE id = $1', [cashAccId]);
                    if (accRes.rows.length > 0) {
                        accType = accRes.rows[0].type;
                    } else {
                        cashAccId = null;
                    }
                }

                const method = accType === 'cash' ? 'Наличные (Касса)' : 'Безналичный расчет';
                // Для money-origin в формуле сальдо:
                // income увеличивает их платежи (theirPayments) и уменьшает наш долг;
                // expense увеличивает наши платежи (ourPayments) и увеличивает долг сотрудника перед нами.
                // Поэтому начисление сотруднику (+) должно быть income, удержание (-) — expense.
                const txType = amountBig.gte(0) ? 'income' : 'expense';
                const txAmount = amountBig.abs().toFixed(2);
                const txCategory = safeCategory || (txType === 'expense' ? HR_SALARY_EXPENSE_CATEGORY : 'Возврат подотчетных средств');
                const txSystemType = postingMode === 'none'
                    ? 'salary_period_adjustment'
                    : (txType === 'expense' ? 'salary_adjustment_cash_out' : 'salary_adjustment_cash_in');
                const authorId = req.user ? req.user.id : null;

                const transRes = await client.query(
                    `INSERT INTO transactions
                        (account_id, counterparty_id, employee_id, salary_adjustment_id, amount, transaction_type, category, description, payment_method, source_module, system_type, transaction_date, user_id)
                     VALUES
                        ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'salary', $10, $11, $12)
                     RETURNING id`,
                    [cashAccId, cpId, employee_id, adjustmentId, txAmount, txType, txCategory, effectiveDescription, method, txSystemType, effectiveDate, authorId]
                );
                await client.query(
                    'UPDATE salary_adjustments SET linked_transaction_id = $1 WHERE id = $2',
                    [transRes.rows[0].id, adjustmentId]
                );
            });

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
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления корректировки' });
        try {
            // 🛡️ ЗАЩИТА: Проверяем, не закрыт ли месяц перед удалением
            const adj = await pool.query('SELECT month_str, linked_transaction_id FROM salary_adjustments WHERE id = $1', [req.params.id]);
            if (adj.rows.length > 0 && await isMonthClosed(pool, adj.rows[0].month_str)) {
                return res.status(403).json({ error: "Нельзя удалять операции из закрытого месяца." });
            }
            await withTransaction(pool, async (client) => {
                const linkedTransactionId = adj.rows[0]?.linked_transaction_id || null;
                await client.query(`UPDATE salary_adjustments SET is_deleted = true WHERE id = $1`, [req.params.id]);
                if (linkedTransactionId) {
                    const txRes = await client.query(
                        'SELECT id, account_id FROM transactions WHERE id = $1 LIMIT 1',
                        [linkedTransactionId]
                    );
                    await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [linkedTransactionId]);
                    const affectedAccountId = txRes.rows[0]?.account_id || null;
                    if (affectedAccountId) {
                        await recalcAccountBalances(client, [affectedAccountId]);
                    }
                }
            });
            await auditLog(pool, req, 'salary_adjustment_delete', 'salary_adjustment', Number(req.params.id), `reason=${reason}`);
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

                // Находим контрагента/подотчетный счет сотрудника строго по employee_id
                const links = await resolveEmployeeFinanceLinks(client, employee_id);
                const counterparty_id = links.counterpartyId;
                const imprestAccountId = links.imprestAccountId;

                // 2. Списываем из кассы (только если сумма > 0)
                const hrAuthorId = req.user ? req.user.id : null;
                if (payAmount.gt(0)) {
                    const transRes = await client.query(
                        `
                        INSERT INTO transactions (account_id, counterparty_id, employee_id, amount, transaction_type, category, description, payment_method, source_module, system_type, transaction_date, user_id) 
                        VALUES ($1, $2, $3, $4, 'expense', $5, $6, $7, 'salary', 'salary_payment', $8, $9) RETURNING id
                    `,
                        [
                            account_id,
                            counterparty_id,
                            employee_id,
                            amountStr,
                            HR_SALARY_EXPENSE_CATEGORY,
                            `Выплата сотруднику: ${description}`,
                            paymentMethod,
                            date + ' 12:00:00',
                            hrAuthorId
                        ]
                    );
                    linkedTransactionId = transRes.rows[0].id;
                }

                // 3. Если есть удержание подотчета - гасим виртуальный счет
                if (deductionAmount.gt(0)) {
                    if (!imprestAccountId) throw new Error('Подотчетный счет сотрудника не найден');
                    await client.query(`
                        INSERT INTO transactions (account_id, counterparty_id, employee_id, amount, transaction_type, category, description, payment_method, source_module, system_type, transaction_date, user_id)
                        VALUES ($1, $2, $3, $4, 'expense', 'Удержание из ЗП', 'Автоматическое погашение подотчета', 'Взаимозачет', 'salary', 'salary_imprest_deduction', $5, $6)
                    `, [imprestAccountId, counterparty_id, employee_id, deductionAmount.toFixed(2), date + ' 12:01:00', hrAuthorId]);
                }

                // 4. Записываем факт выплаты в зарплатную таблицу (полная сумма: руки + удержание)
                const totalCleared = payAmount.plus(deductionAmount).toFixed(2);
                await client.query(`
                    INSERT INTO salary_payments (employee_id, amount, payment_date, description, account_id, linked_transaction_id, user_id) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [employee_id, totalCleared, date, description, account_id, linkedTransactionId, hrAuthorId]);
            });

            res.json({ success: true });
        } catch (err) {
            logger.error('Ошибка выплаты:', err.message);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    router.delete('/api/salary/payment/:id', requireAdmin, async (req, res) => {
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления выплаты' });
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
            await auditLog(pool, req, 'salary_payment_delete', 'salary_payment', Number(req.params.id), `reason=${reason}`);
            res.json({ success: true });
        } catch (err) { logger.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
    });

    // ==================================================================
    // 5. ЗАКРЫТИЕ ПЕРИОДА И ТЕХНИЧЕСКИЕ РОУТЫ
    // ==================================================================

    // ОБНОВЛЕННЫЙ РОУТ: Получение выплат (улучшен сбор динамических балансов)
    router.get('/api/salary/balances', async (req, res) => {
        const { year, month } = req.query;
        let monthFilter = '';
        let params = [];
        if (year && month) {
            monthFilter = `AND t.transaction_date <= $1::timestamp`;
            params.push(`${year}-${month}-01`);
        }

        try {
            // Динамический расчет prev_balance (строго по транзакциям)
            const result = await pool.query(`
            SELECT e.id, e.full_name, e.status, e.department,
                   COALESCE(a.balance, 0) AS imprest_debt,
                   COALESCE(
                       (SELECT SUM(CASE 
                            WHEN t.transaction_type = 'income' THEN t.amount 
                            ELSE -t.amount 
                          END) 
                        FROM transactions t
                        LEFT JOIN counterparties cp ON t.counterparty_id = cp.id
                        WHERE (t.employee_id = e.id OR cp.employee_id = e.id)
                          AND (
                              t.source_module = 'salary'
                              OR t.system_type IN ('salary_payment', 'salary_imprest_deduction', 'salary_accrual', 'salary_tax_withhold', 'salary_period_adjustment')
                              OR t.category IN ('Начисление ЗП', 'Зарплата', 'Оплата труда', 'Зарплата и Авансы', 'Премии', 'Штрафы', 'Удержание из ЗП', 'Ввод начальных остатков')
                          )
                          ${monthFilter}
                          AND COALESCE(t.is_deleted, false) = false
                       ), 0
                   ) AS prev_balance
            FROM employees e
            LEFT JOIN accounts a ON a.employee_id = e.id AND a.type = 'imprest'
            WHERE e.status = 'active'
               OR EXISTS (SELECT 1 FROM transactions t2 JOIN counterparties cp2 ON t2.counterparty_id = cp2.id WHERE cp2.employee_id = e.id)
               ${year && month ? `OR EXISTS (SELECT 1 FROM timesheet_records WHERE employee_id = e.id AND record_date >= $1::date AND record_date < ($1::date + interval '1 month'))` : ''}
        `, params);
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
        const reason = String((req.body || {}).reason || '').trim();

        if (!/^\d{4}-\d{2}$/.test(monthStr)) {
            return res.status(400).json({ error: 'Неверный формат месяца' });
        }
        if (!reason) {
            return res.status(400).json({ error: 'Укажите причину закрытия месяца' });
        }

        try {
            await withTransaction(pool, async (client) => {
                const closeBatchId = crypto.randomUUID();
                // Проверяем, не закрыт ли месяц дважды
                const check = await client.query('SELECT 1 FROM closed_periods WHERE period_str = $1 AND module = $2', [monthStr, 'salary']);
                if (check.rows.length > 0) throw new Error('Этот месяц уже закрыт.');

                // Убрано обновление e.prev_balance в таблице employees, так как мы берем его теперь из транзакций динамически.
                // Интеграция с Финансами: Формируем "Начисление ЗП" (Обязательство), Налоги и Корректировки для КАЖДОГО сотрудника
                for (let b of balances) {
                    const cpRes = await client.query('SELECT id FROM counterparties WHERE employee_id = $1 LIMIT 1', [b.employee_id]);
                    if (cpRes.rows.length > 0) {
                        const cpId = cpRes.rows[0].id;
                        const closeAuthorId = req.user ? req.user.id : null;

                        // 1. Начисление ЗП
                        if (b.accrued && parseFloat(b.accrued) > 0) {
                            await client.query(`
                                INSERT INTO transactions 
                                (amount, transaction_type, category, description, counterparty_id, employee_id, account_id, payment_method, source_module, system_type, generation_batch_id, transaction_date, user_id)
                                VALUES ($1, 'income', 'Начисление ЗП', $2, $3, $4, NULL, 'Взаимозачет', 'salary', 'salary_accrual', $5, (date_trunc('month', $6::date) + interval '1 month' - interval '1 second')::timestamp, $7)
                            `, [b.accrued, 'Начислено за период: ' + monthStr, cpId, b.employee_id, closeBatchId, `${monthStr}-01`, closeAuthorId]);
                        }

                        // 2. Удержание Налога
                        if (b.tax && parseFloat(b.tax) > 0) {
                            await client.query(`
                                INSERT INTO transactions 
                                (amount, transaction_type, category, description, counterparty_id, employee_id, account_id, payment_method, source_module, system_type, generation_batch_id, transaction_date, user_id)
                                VALUES ($1, 'expense', 'Удержание из ЗП', $2, $3, $4, NULL, 'Взаимозачет', 'salary', 'salary_tax_withhold', $5, (date_trunc('month', $6::date) + interval '1 month' - interval '1 second')::timestamp, $7)
                            `, [parseFloat(b.tax).toFixed(2), 'Удержан налог за период: ' + monthStr, cpId, b.employee_id, closeBatchId, `${monthStr}-01`, closeAuthorId]);
                        }

                        // 3. Корректировки (adjSum)
                        if (b.adjSum && parseFloat(b.adjSum) !== 0) {
                            const adj = parseFloat(b.adjSum);
                            const tType = adj > 0 ? 'income' : 'expense';
                            const tCat = adj > 0 ? 'Премии' : 'Удержание из ЗП';

                            await client.query(`
                                INSERT INTO transactions 
                                (amount, transaction_type, category, description, counterparty_id, employee_id, account_id, payment_method, source_module, system_type, generation_batch_id, transaction_date, user_id)
                                VALUES ($1, $2, $3, $4, $5, $6, NULL, 'Взаимозачет', 'salary', 'salary_period_adjustment', $7, (date_trunc('month', $8::date) + interval '1 month' - interval '1 second')::timestamp, $9)
                            `, [Math.abs(adj).toFixed(2), tType, tCat, 'Доп. корректировки за период: ' + monthStr, cpId, b.employee_id, closeBatchId, `${monthStr}-01`, closeAuthorId]);
                        }

                        // 4. Авто-перенос незакрытого подотчета в зарплату (удержание) при закрытии месяца
                        const imprestRes = await client.query(
                            `SELECT id, COALESCE(balance, 0)::numeric AS balance
                             FROM accounts
                             WHERE employee_id = $1
                               AND (account_role = 'imprest' OR type = 'imprest')
                             ORDER BY id ASC
                             LIMIT 1`,
                            [b.employee_id]
                        );
                        if (imprestRes.rows.length > 0) {
                            const imprestAccountId = imprestRes.rows[0].id;
                            const imprestDebt = parseFloat(imprestRes.rows[0].balance || 0);
                            if (imprestDebt > 0.0001) {
                                const deductionAmount = Number(imprestDebt.toFixed(2));
                                const txRes = await client.query(
                                    `
                                    INSERT INTO transactions
                                        (amount, transaction_type, category, description, counterparty_id, employee_id, account_id, payment_method, source_module, system_type, generation_batch_id, transaction_date, user_id)
                                    VALUES
                                        ($1, 'expense', 'Удержание из ЗП', $2, $3, $4, $5, 'Взаимозачет', 'salary', 'salary_imprest_deduction', $6, (date_trunc('month', $7::date) + interval '1 month' - interval '1 second')::timestamp, $8)
                                    RETURNING id
                                `,
                                    [
                                        deductionAmount,
                                        `Автоперенос подотчета в ЗП за период: ${monthStr}`,
                                        cpId,
                                        b.employee_id,
                                        imprestAccountId,
                                        closeBatchId,
                                        `${monthStr}-01`,
                                        closeAuthorId
                                    ]
                                );

                                const adjRes = await client.query(
                                    `
                                    INSERT INTO salary_adjustments
                                        (employee_id, month_str, amount, description, counterparty_id, linked_transaction_id, cash_posting_mode, cash_account_id, operation_kind, source_module)
                                    VALUES
                                        ($1, $2, $3, $4, $5, $6, 'imprest', $7, 'imprest_settlement', 'salary')
                                    RETURNING id
                                `,
                                    [
                                        b.employee_id,
                                        monthStr,
                                        -deductionAmount,
                                        `Удержание неотчитанного подотчета за период: ${monthStr}`,
                                        cpId,
                                        txRes.rows[0].id,
                                        imprestAccountId
                                    ]
                                );

                                await client.query(
                                    'UPDATE transactions SET salary_adjustment_id = $1 WHERE id = $2',
                                    [adjRes.rows[0].id, txRes.rows[0].id]
                                );

                                // Баланс подотчетного счета должен обнулиться после удержания
                                await recalcAccountBalances(client, [imprestAccountId]);
                            }
                        }
                    }
                }

                // Записываем месяц в архив и фиксируем сумму налогов
                await client.query(
                    'INSERT INTO closed_periods (period_str, module, total_taxes) VALUES ($1, $2, $3)',
                    [monthStr, 'salary', totalTaxes || 0]
                );
            });

            await auditLog(pool, req, 'salary_month_close', 'closed_period', null, `month=${monthStr}; reason=${reason}`);
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
        const reason = String((req.body || {}).reason || '').trim();

        if (!/^\d{4}-\d{2}$/.test(monthStr)) {
            return res.status(400).json({ error: 'Неверный формат месяца' });
        }
        if (!reason) {
            return res.status(400).json({ error: 'Укажите причину отмены закрытия месяца' });
        }

        try {
            await withTransaction(pool, async (client) => {
                // Проверяем, закрыт ли месяц на самом деле
                const check = await client.query('SELECT 1 FROM closed_periods WHERE period_str = $1 AND module = $2', [monthStr, 'salary']);
                if (check.rows.length === 0) throw new Error('Этот месяц не закрыт или уже был открыт.');

                // А) Удаление сгенерированных автоматических транзакций
                // Описание у нас жестко фиксировано: "Начислено за период: YYYY-MM"
                // Больше никаких откатов e.prev_balance не нужно, так как сальдо динамическое!

                // Б) Удаление сгенерированных автоматических транзакций (включая налоги и корректировки)
                await client.query(`
                    UPDATE transactions
                    SET is_deleted = true
                    WHERE source_module = 'salary'
                      AND system_type IN ('salary_accrual', 'salary_tax_withhold', 'salary_period_adjustment', 'salary_imprest_deduction')
                      AND transaction_date >= $1::date
                      AND transaction_date < ($1::date + interval '1 month')
                      AND COALESCE(is_deleted, false) = false
                `, [`${monthStr}-01`]);

                await client.query(
                    `UPDATE salary_adjustments
                     SET is_deleted = true
                     WHERE month_str = $1
                       AND source_module = 'salary'
                       AND operation_kind = 'imprest_settlement'
                       AND COALESCE(is_deleted, false) = false`,
                    [monthStr]
                );

                // В) Удаление блокировок из архива закрытых периодов
                await client.query(`DELETE FROM closed_periods WHERE period_str = $1 AND module = 'salary'`, [monthStr]);
            });

            await auditLog(pool, req, 'salary_month_reopen', 'closed_period', null, `month=${monthStr}; reason=${reason}`);
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