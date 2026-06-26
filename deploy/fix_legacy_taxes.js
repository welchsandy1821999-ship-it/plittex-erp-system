#!/usr/bin/env node
// fix_legacy_taxes.js — удалить дублирующиеся legacy налоговые удержания

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
    console.log('=== ИСПРАВЛЕНИЕ LEGACY НАЛОГОВ ===\n');

    // 1. Показать все активные legacy налоги
    console.log('--- 1. Активные legacy налоговые удержания ---');
    await exec(conn, Q(`
        SELECT leg.id, leg.employee_id, e.full_name, leg.amount, leg.description, leg.transaction_date::date,
               (SELECT COUNT(*) FROM transactions t2
                WHERE t2.employee_id = leg.employee_id
                  AND t2.system_type = 'salary_tax_withhold'
                  AND date_trunc('month', t2.transaction_date) = date_trunc('month', leg.transaction_date)
                  AND COALESCE(t2.is_deleted, false) = false
               ) AS has_tax_replacement
        FROM transactions leg
        LEFT JOIN employees e ON e.id = leg.employee_id
        WHERE leg.system_type = 'salary_legacy_action'
          AND leg.description LIKE 'Удержан налог%'
          AND COALESCE(leg.is_deleted, false) = false
        ORDER BY leg.transaction_date, leg.employee_id
    `));

    // 2. Удалить legacy налоги, у которых ЕСТЬ замена salary_tax_withhold
    console.log('\n--- 2. Удаляем legacy налоги с дубликатом ---');
    await exec(conn, Q(`
        UPDATE transactions leg
        SET is_deleted = true
        WHERE leg.system_type = 'salary_legacy_action'
          AND leg.description LIKE 'Удержан налог%'
          AND COALESCE(leg.is_deleted, false) = false
          AND EXISTS (
              SELECT 1 FROM transactions t2
              WHERE t2.employee_id = leg.employee_id
                AND t2.system_type = 'salary_tax_withhold'
                AND date_trunc('month', t2.transaction_date) = date_trunc('month', leg.transaction_date)
                AND COALESCE(t2.is_deleted, false) = false
          )
    `));

    // 3. Проверяем баланс на начало Мая после исправления
    console.log('\n--- 3. Баланс на начало Мая (после исправления) ---');
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

    // 4. Проверка Чухарева: net за Апрель
    console.log('\n--- 4. Net Чухарева за Апрель (должно быть -5379) ---');
    await exec(conn, Q(`
        SELECT SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END) AS apr_net
        FROM transactions t
        LEFT JOIN counterparties cp ON t.counterparty_id=cp.id
        WHERE (t.employee_id=18 OR cp.employee_id=18)
          AND (t.source_module='salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment','salary_legacy_action') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков'))
          AND t.transaction_date >= '2026-04-01' AND t.transaction_date < '2026-05-01'
          AND COALESCE(t.is_deleted,false)=false
    `));

    // 5. Баланс на начало Апреля (не должен измениться)
    console.log('\n--- 5. Баланс на начало Апреля (контроль: должен остаться 262685) ---');
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
        FROM employees e WHERE e.id = 18
    `));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
