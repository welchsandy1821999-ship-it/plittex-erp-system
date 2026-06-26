#!/usr/bin/env node
// full_balance_check.js — сравнение "К ВЫДАЧЕ" (фронтенд) vs "Баланс на начало след. месяца" (БД)

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
    console.log('=== ПОЛНАЯ ДИАГНОСТИКА ВСЕХ МЕСЯЦЕВ ===\n');

    // Для каждого месяца: что лежит в транзакциях (доходы vs расходы) по каждому сотруднику
    for (const month of ['2026-03', '2026-04', '2026-05', '2026-06']) {
        console.log(`\n========== ${month} ==========`);
        
        // Баланс на НАЧАЛО месяца (из транзакций)
        console.log(`\n--- Баланс на НАЧАЛО ${month} (из транзакций) ---`);
        await exec(conn, Q(`
            SELECT e.id, e.full_name,
                   COALESCE((SELECT SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END)
                             FROM transactions t
                             LEFT JOIN counterparties cp ON t.counterparty_id=cp.id
                             WHERE (t.employee_id=e.id OR cp.employee_id=e.id)
                               AND (t.source_module='salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment','salary_legacy_action') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков'))
                               AND t.transaction_date < '${month}-01'
                               AND COALESCE(t.is_deleted,false)=false
                            ),0) AS prev_balance
            FROM employees e WHERE e.status='active' OR e.id IN (SELECT DISTINCT employee_id FROM timesheet_records WHERE record_date >= '${month}-01' AND record_date < ('${month}-01'::date + interval '1 month'))
            ORDER BY e.id
        `));

        // Транзакции ЗА месяц (подробно по типу)
        console.log(`\n--- Транзакции ЗА ${month} (по типу) ---`);
        await exec(conn, Q(`
            SELECT t.employee_id, e.full_name,
                   SUM(CASE WHEN t.system_type='salary_accrual' AND t.transaction_type='income' THEN t.amount ELSE 0 END) AS accrual,
                   SUM(CASE WHEN t.system_type='salary_legacy_action' AND t.transaction_type='income' THEN t.amount ELSE 0 END) AS legacy_accrual,
                   SUM(CASE WHEN t.system_type IN ('salary_tax_withhold') AND t.transaction_type='expense' THEN t.amount ELSE 0 END) AS tax_new,
                   SUM(CASE WHEN t.system_type='salary_legacy_action' AND t.transaction_type='expense' THEN t.amount ELSE 0 END) AS tax_legacy,
                   SUM(CASE WHEN t.category='Зарплата и Авансы' AND t.system_type IS NULL AND t.transaction_type='expense' THEN t.amount ELSE 0 END) AS advances_tx,
                   SUM(CASE WHEN t.system_type='salary_period_adjustment' THEN 
                       CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END ELSE 0 END) AS adj_tx,
                   SUM(CASE WHEN t.system_type='salary_payment' AND t.transaction_type='expense' THEN t.amount ELSE 0 END) AS product_advances
            FROM transactions t
            LEFT JOIN employees e ON e.id=t.employee_id
            LEFT JOIN counterparties cp ON t.counterparty_id=cp.id
            WHERE (t.employee_id IS NOT NULL OR cp.employee_id IS NOT NULL)
              AND (t.source_module='salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment','salary_legacy_action') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков'))
              AND t.transaction_date >= '${month}-01' AND t.transaction_date < ('${month}-01'::date + interval '1 month')
              AND COALESCE(t.is_deleted,false)=false
            GROUP BY t.employee_id, e.full_name
            ORDER BY t.employee_id
        `));

        // salary_adjustments за месяц
        console.log(`\n--- salary_adjustments за ${month} ---`);
        await exec(conn, Q(`
            SELECT sa.employee_id, e.full_name, SUM(sa.amount) AS adj_sum
            FROM salary_adjustments sa
            JOIN employees e ON e.id=sa.employee_id
            WHERE sa.month_str='${month}' AND COALESCE(sa.is_deleted,false)=false
            GROUP BY sa.employee_id, e.full_name
            ORDER BY sa.employee_id
        `));

        // salary_payments за месяц
        console.log(`\n--- salary_payments за ${month} ---`);
        await exec(conn, Q(`
            SELECT sp.employee_id, e.full_name, SUM(sp.amount) AS advances_sum
            FROM salary_payments sp
            JOIN employees e ON e.id=sp.employee_id
            WHERE sp.payment_date >= '${month}-01' AND sp.payment_date < ('${month}-01'::date + interval '1 month')
              AND COALESCE(sp.is_deleted,false)=false
            GROUP BY sp.employee_id, e.full_name
            ORDER BY sp.employee_id
        `));
    }

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
