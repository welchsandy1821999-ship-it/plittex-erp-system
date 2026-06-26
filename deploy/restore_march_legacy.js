#!/usr/bin/env node
// restore_march_legacy.js — восстановить мартовские legacy, у которых нет salary_accrual замены

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
    console.log('=== ВОССТАНОВЛЕНИЕ МАРТОВСКИХ LEGACY ===\n');

    // Шаг 1: Восстановить все salary_legacy_action, у которых НЕТ salary_accrual замены за тот же месяц
    console.log('--- Восстановление legacy без замены ---');
    await exec(conn, Q(`
        UPDATE transactions leg
        SET is_deleted = false
        WHERE leg.system_type = 'salary_legacy_action'
          AND leg.is_deleted = true
          AND NOT EXISTS (
              SELECT 1 FROM transactions t2
              WHERE t2.employee_id = leg.employee_id
                AND t2.system_type = 'salary_accrual'
                AND date_trunc('month', t2.transaction_date) = date_trunc('month', leg.transaction_date)
                AND COALESCE(t2.is_deleted, false) = false
          )
    `));

    // Шаг 2: Проверим балансы после восстановления
    console.log('\n--- Баланс на начало Апреля (после восстановления) ---');
    await exec(conn, Q(`
        SELECT e.id, e.full_name,
               COALESCE((SELECT SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END) 
                         FROM transactions t 
                         LEFT JOIN counterparties cp ON t.counterparty_id=cp.id 
                         WHERE (t.employee_id=e.id OR cp.employee_id=e.id) 
                           AND (t.source_module='salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment','salary_legacy_action') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков')) 
                           AND t.transaction_date < '2026-04-01' 
                           AND COALESCE(t.is_deleted,false)=false
                        ),0) AS balance_before_apr
        FROM employees e WHERE e.status='active' ORDER BY e.id
    `));

    // Шаг 3: Баланс на начало Мая
    console.log('\n--- Баланс на начало Мая (после восстановления) ---');
    await exec(conn, Q(`
        SELECT e.id, e.full_name,
               COALESCE((SELECT SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END) 
                         FROM transactions t 
                         LEFT JOIN counterparties cp ON t.counterparty_id=cp.id 
                         WHERE (t.employee_id=e.id OR cp.employee_id=e.id) 
                           AND (t.source_module='salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment','salary_legacy_action') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков')) 
                           AND t.transaction_date < '2026-05-01' 
                           AND COALESCE(t.is_deleted,false)=false
                        ),0) AS balance_before_may
        FROM employees e WHERE e.status='active' ORDER BY e.id
    `));

    // Шаг 4: Проверить что для Апреля нет задвоений (должен быть ровно 1 accrual ИЛИ 1 legacy, не оба)
    console.log('\n--- Проверка: нет задвоений за Апрель ---');
    await exec(conn, Q(`
        SELECT employee_id, e.full_name,
               COUNT(*) FILTER(WHERE system_type='salary_accrual' AND COALESCE(is_deleted,false)=false) AS accrual_count,
               COUNT(*) FILTER(WHERE system_type='salary_legacy_action' AND COALESCE(is_deleted,false)=false) AS legacy_count,
               COUNT(*) FILTER(WHERE system_type IN ('salary_accrual','salary_legacy_action') AND COALESCE(is_deleted,false)=false) AS total_active
        FROM transactions t
        LEFT JOIN employees e ON e.id = t.employee_id
        WHERE t.transaction_date >= '2026-04-01' AND t.transaction_date < '2026-05-01'
          AND t.system_type IN ('salary_accrual', 'salary_legacy_action')
          AND description LIKE 'Начислено за период:%'
        GROUP BY employee_id, e.full_name
        ORDER BY employee_id
    `));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
