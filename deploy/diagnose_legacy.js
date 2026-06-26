#!/usr/bin/env node
// diagnose_legacy.js — понять, какие legacy были единственным источником, и восстановить их

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
    console.log('=== ДИАГНОСТИКА УДАЛЁННЫХ LEGACY ===\n');

    // 1. Показать ВСЕ удалённые salary_legacy_action (что я сломал)
    console.log('--- 1. Удалённые salary_legacy_action ---');
    await exec(conn, Q(`
        SELECT id, employee_id, amount, transaction_type, description, transaction_date::date, is_deleted
        FROM transactions 
        WHERE system_type = 'salary_legacy_action' 
          AND is_deleted = true
        ORDER BY transaction_date, employee_id
    `));

    // 2. Для каждого удалённого legacy — проверить, есть ли salary_accrual за тот же месяц и сотрудника
    console.log('\n--- 2. Legacy без дубликата (нужно восстановить) ---');
    await exec(conn, Q(`
        SELECT leg.id, leg.employee_id, e.full_name, leg.amount, leg.transaction_type, leg.description, leg.transaction_date::date,
               (SELECT COUNT(*) FROM transactions t2 
                WHERE t2.employee_id = leg.employee_id 
                  AND t2.system_type = 'salary_accrual'
                  AND date_trunc('month', t2.transaction_date) = date_trunc('month', leg.transaction_date)
                  AND COALESCE(t2.is_deleted, false) = false
               ) AS has_accrual_replacement
        FROM transactions leg
        LEFT JOIN employees e ON e.id = leg.employee_id
        WHERE leg.system_type = 'salary_legacy_action'
          AND leg.is_deleted = true
        ORDER BY leg.transaction_date, leg.employee_id
    `));

    // 3. Проверяем Чухарева: все его транзакции за март-апрель
    console.log('\n--- 3. Все salary-транзакции Чухарева (id=18) за Март-Апрель ---');
    await exec(conn, Q(`
        SELECT id, amount, transaction_type, system_type, category, transaction_date::date, description, is_deleted
        FROM transactions 
        WHERE employee_id = 18
          AND (source_module = 'salary' OR system_type LIKE 'salary_%' OR category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков'))
          AND transaction_date >= '2026-03-01' AND transaction_date < '2026-05-01'
        ORDER BY transaction_date, id
    `));

    // 4. Текущий баланс Чухарева до апреля
    console.log('\n--- 4. Баланс Чухарева до 2026-04-01 (текущий, после моей очистки) ---');
    await exec(conn, Q(`
        SELECT COALESCE(SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END), 0) AS balance_before_apr
        FROM transactions t
        LEFT JOIN counterparties cp ON t.counterparty_id = cp.id
        WHERE (t.employee_id = 18 OR cp.employee_id = 18)
          AND (t.source_module = 'salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment','salary_legacy_action') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков'))
          AND t.transaction_date < '2026-04-01'
          AND COALESCE(t.is_deleted, false) = false
    `));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
