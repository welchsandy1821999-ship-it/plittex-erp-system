#!/usr/bin/env node
// salary_audit.js — проверка расчетов зарплаты на продакшн

const { Client } = require('ssh2');
const conn = new Client();

function exec(conn, cmd) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let out = '';
            stream.on('data', d => { process.stdout.write(d.toString()); out += d; });
            stream.stderr.on('data', d => process.stdout.write('[E] ' + d.toString()));
            stream.on('close', () => resolve(out));
        });
    });
}

const Q = (sql) => `PGPASSWORD='ERP_secret_2026' psql -U plittex -h 127.0.0.1 -d plittex_erp -c "${sql.replace(/"/g, '\\"')}" 2>&1`;

conn.on('ready', async () => {
    console.log('=== АУДИТ ЗАРПЛАТЫ — ПРОДАКШН ===\n');

    // 1. Структура таблиц
    console.log('--- 1. Таблицы salary_* ---');
    await exec(conn, Q("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ('salary_payments','salary_adjustments','monthly_salary_stats','closed_periods','employees') AND table_schema='public' ORDER BY table_name, ordinal_position;"));

    // 2. Закрытые периоды
    console.log('\n--- 2. Закрытые периоды ---');
    await exec(conn, Q("SELECT * FROM closed_periods WHERE module='salary' ORDER BY period_str;"));

    // 3. Сотрудники с prev_balance
    console.log('\n--- 3. Сотрудники (prev_balance) ---');
    await exec(conn, Q("SELECT id, full_name, salary_cash, prev_balance, status FROM employees WHERE status='active' ORDER BY id;"));

    // 4. Выплаты (salary_payments) за Апрель 2026
    console.log('\n--- 4. Выплаты Апрель 2026 ---');
    await exec(conn, Q("SELECT sp.employee_id, e.full_name, sp.amount, sp.payment_date::date, sp.description FROM salary_payments sp JOIN employees e ON e.id=sp.employee_id WHERE sp.payment_date >= '2026-04-01' AND sp.payment_date < '2026-05-01' AND COALESCE(sp.is_deleted,false)=false ORDER BY sp.employee_id, sp.payment_date;"));

    // 5. Транзакции salary за Апрель 2026
    console.log('\n--- 5. Транзакции salary Апрель 2026 ---');
    await exec(conn, Q("SELECT t.employee_id, e.full_name, t.amount, t.transaction_type, t.system_type, t.category, t.transaction_date::date FROM transactions t LEFT JOIN employees e ON e.id=t.employee_id WHERE (t.source_module='salary' OR t.system_type LIKE 'salary_%') AND t.transaction_date >= '2026-04-01' AND t.transaction_date < '2026-05-01' AND COALESCE(t.is_deleted,false)=false ORDER BY t.employee_id, t.transaction_date;"));

    // 6. Транзакции salary за Май 2026
    console.log('\n--- 6. Транзакции salary Май 2026 ---');
    await exec(conn, Q("SELECT t.employee_id, e.full_name, t.amount, t.transaction_type, t.system_type, t.category, t.transaction_date::date FROM transactions t LEFT JOIN employees e ON e.id=t.employee_id WHERE (t.source_module='salary' OR t.system_type LIKE 'salary_%') AND t.transaction_date >= '2026-05-01' AND t.transaction_date < '2026-06-01' AND COALESCE(t.is_deleted,false)=false ORDER BY t.employee_id, t.transaction_date;"));

    // 7. Баланс через /api/salary/balances логику
    console.log('\n--- 7. Динамический prev_balance (до 2026-04-01) = остаток на начало апреля ---');
    await exec(conn, Q("SELECT e.id, e.full_name, COALESCE((SELECT SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END) FROM transactions t LEFT JOIN counterparties cp ON t.counterparty_id=cp.id WHERE (t.employee_id=e.id OR cp.employee_id=e.id) AND (t.source_module='salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков')) AND t.transaction_date < '2026-04-01' AND COALESCE(t.is_deleted,false)=false),0) AS balance_before_apr FROM employees e WHERE e.status='active' ORDER BY e.id;"));

    // 8. prev_balance до 2026-05-01 (остаток на начало мая)
    console.log('\n--- 8. Динамический prev_balance (до 2026-05-01) = остаток на начало мая ---');
    await exec(conn, Q("SELECT e.id, e.full_name, COALESCE((SELECT SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END) FROM transactions t LEFT JOIN counterparties cp ON t.counterparty_id=cp.id WHERE (t.employee_id=e.id OR cp.employee_id=e.id) AND (t.source_module='salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков')) AND t.transaction_date < '2026-05-01' AND COALESCE(t.is_deleted,false)=false),0) AS balance_before_may FROM employees e WHERE e.status='active' ORDER BY e.id;"));

    // 9. Корректировки (salary_adjustments) за апрель-май
    console.log('\n--- 9. Корректировки salary_adjustments (Apr-May) ---');
    await exec(conn, Q("SELECT sa.employee_id, e.full_name, sa.month_str, sa.amount, sa.description, sa.operation_kind FROM salary_adjustments sa JOIN employees e ON e.id=sa.employee_id WHERE sa.month_str IN ('2026-04','2026-05') AND COALESCE(sa.is_deleted,false)=false ORDER BY sa.month_str, sa.employee_id;"));

    // 10. Timesheet суммарные данные за Апрель
    console.log('\n--- 10. Timesheet суммы за Апрель 2026 ---');
    await exec(conn, Q("SELECT tr.employee_id, e.full_name, COUNT(*) FILTER(WHERE tr.status='present') AS days_present, COUNT(*) FILTER(WHERE tr.status='partial') AS days_partial, SUM(COALESCE(tr.bonus,0)) AS total_bonus, SUM(COALESCE(tr.penalty,0)) AS total_penalty FROM timesheet_records tr JOIN employees e ON e.id=tr.employee_id WHERE tr.record_date >= '2026-04-01' AND tr.record_date < '2026-05-01' GROUP BY tr.employee_id, e.full_name ORDER BY tr.employee_id;"));

    conn.end();
    console.log('\n=== АУДИТ ЗАВЕРШЕН ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
