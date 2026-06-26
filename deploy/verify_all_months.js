#!/usr/bin/env node
// verify_all_months.js — полная верификация перехода остатков по месяцам

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
    console.log('=== ВЕРИФИКАЦИЯ ПЕРЕХОДОВ ===\n');

    // Проверка Чухарева (id=18): все salary-related транзакции
    console.log('--- Все salary-транзакции Чухарева (id=18) помесячно ---');
    await exec(conn, Q(`
        SELECT to_char(date_trunc('month', t.transaction_date), 'YYYY-MM') AS month,
               SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE 0 END) AS total_income,
               SUM(CASE WHEN t.transaction_type='expense' THEN t.amount ELSE 0 END) AS total_expense,
               SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END) AS net
        FROM transactions t
        LEFT JOIN counterparties cp ON t.counterparty_id = cp.id
        WHERE (t.employee_id = 18 OR cp.employee_id = 18)
          AND (t.source_module = 'salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment','salary_legacy_action') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков'))
          AND COALESCE(t.is_deleted, false) = false
        GROUP BY date_trunc('month', t.transaction_date)
        ORDER BY month
    `));

    // Кумулятивные балансы для ВСЕХ сотрудников на конец каждого месяца
    const months = ['2026-03', '2026-04', '2026-05', '2026-06'];
    for (const m of months) {
        console.log(`\n--- Баланс на начало ${m} ---`);
        await exec(conn, Q(`
            SELECT e.id, e.full_name,
                   COALESCE((SELECT SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END)
                             FROM transactions t
                             LEFT JOIN counterparties cp ON t.counterparty_id=cp.id
                             WHERE (t.employee_id=e.id OR cp.employee_id=e.id)
                               AND (t.source_module='salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment','salary_legacy_action') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков'))
                               AND t.transaction_date < '${m}-01'
                               AND COALESCE(t.is_deleted,false)=false
                            ),0) AS balance
            FROM employees e
            WHERE e.id = 18 OR e.id = 14 OR e.id = 1 OR e.id = 5
            ORDER BY e.id
        `));
    }

    // Проверяем что ВСЕ апрельские legacy остаются удалёнными (не восстановлены)
    console.log('\n--- Статус апрельских legacy (должны быть is_deleted=true) ---');
    await exec(conn, Q(`
        SELECT id, employee_id, amount, is_deleted, description
        FROM transactions
        WHERE system_type = 'salary_legacy_action'
          AND transaction_date >= '2026-04-01' AND transaction_date < '2026-05-01'
          AND description LIKE 'Начислено за период:%'
        ORDER BY employee_id
    `));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
