#!/usr/bin/env node
// mismatch_finder.js — найти ВСЕ рассогласования между salary_adjustments и transactions

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
    console.log('=== ПОИСК РАССОГЛАСОВАНИЙ ===\n');

    // 1. КЛЮЧЕВОЙ ЗАПРОС: salary_adjustments (что фронтенд берет для adjSum) vs salary_period_adjustment транзакции (что DB считает)
    for (const m of ['2026-03', '2026-04', '2026-05', '2026-06']) {
        console.log(`\n--- ${m}: salary_adjustments vs transactions ---`);
        await exec(conn, Q(`
            SELECT 
                COALESCE(sa.employee_id, tx.employee_id) AS emp_id,
                COALESCE(e1.full_name, e2.full_name) AS name,
                COALESCE(sa.adj_sum, 0) AS adj_from_table,
                COALESCE(tx.adj_from_tx, 0) AS adj_from_transactions,
                COALESCE(sa.adj_sum, 0) - COALESCE(tx.adj_from_tx, 0) AS DIFFERENCE
            FROM (
                SELECT employee_id, SUM(amount) AS adj_sum
                FROM salary_adjustments
                WHERE month_str = '${m}' AND COALESCE(is_deleted, false) = false
                GROUP BY employee_id
            ) sa
            FULL OUTER JOIN (
                SELECT employee_id, 
                       SUM(CASE WHEN transaction_type='income' THEN amount ELSE -amount END) AS adj_from_tx
                FROM transactions
                WHERE system_type = 'salary_period_adjustment'
                  AND transaction_date >= '${m}-01' AND transaction_date < ('${m}-01'::date + interval '1 month')
                  AND COALESCE(is_deleted, false) = false
                GROUP BY employee_id
            ) tx ON sa.employee_id = tx.employee_id
            LEFT JOIN employees e1 ON e1.id = sa.employee_id
            LEFT JOIN employees e2 ON e2.id = tx.employee_id
            WHERE COALESCE(sa.adj_sum, 0) - COALESCE(tx.adj_from_tx, 0) != 0
            ORDER BY emp_id
        `));
    }

    // 2. salary_payments vs payment транзакции
    for (const m of ['2026-03', '2026-04', '2026-05', '2026-06']) {
        console.log(`\n--- ${m}: salary_payments vs payment transactions ---`);
        await exec(conn, Q(`
            SELECT 
                COALESCE(sp.employee_id, tx.employee_id) AS emp_id,
                COALESCE(e1.full_name, e2.full_name) AS name,
                COALESCE(sp.pay_sum, 0) AS advances_from_table,
                COALESCE(tx.pay_from_tx, 0) AS advances_from_transactions,
                COALESCE(sp.pay_sum, 0) - COALESCE(tx.pay_from_tx, 0) AS DIFFERENCE
            FROM (
                SELECT employee_id, SUM(amount) AS pay_sum
                FROM salary_payments
                WHERE payment_date >= '${m}-01' AND payment_date < ('${m}-01'::date + interval '1 month')
                  AND COALESCE(is_deleted, false) = false
                GROUP BY employee_id
            ) sp
            FULL OUTER JOIN (
                SELECT t.employee_id,
                       SUM(t.amount) AS pay_from_tx
                FROM transactions t
                WHERE (t.category IN ('Зарплата и Авансы') OR t.system_type = 'salary_payment')
                  AND t.transaction_type = 'expense'
                  AND t.system_type IS DISTINCT FROM 'salary_tax_withhold'
                  AND t.system_type IS DISTINCT FROM 'salary_legacy_action'
                  AND t.system_type IS DISTINCT FROM 'salary_period_adjustment'
                  AND t.system_type IS DISTINCT FROM 'salary_imprest_deduction'
                  AND t.transaction_date >= '${m}-01' AND t.transaction_date < ('${m}-01'::date + interval '1 month')
                  AND COALESCE(t.is_deleted, false) = false
                GROUP BY t.employee_id
            ) tx ON sp.employee_id = tx.employee_id
            LEFT JOIN employees e1 ON e1.id = sp.employee_id
            LEFT JOIN employees e2 ON e2.id = tx.employee_id
            WHERE COALESCE(sp.pay_sum, 0) - COALESCE(tx.pay_from_tx, 0) != 0
            ORDER BY emp_id
        `));
    }

    // 3. Проверим все adj транзакции за Май для Петривой (id=5) подробно
    console.log('\n--- Детализация: все salary_period_adjustment транзакции для emp_id=5 за Май ---');
    await exec(conn, Q(`
        SELECT id, employee_id, amount, transaction_type, description, transaction_date::date, is_deleted
        FROM transactions
        WHERE system_type = 'salary_period_adjustment'
          AND employee_id = 5
          AND transaction_date >= '2026-05-01' AND transaction_date < '2026-06-01'
        ORDER BY id
    `));

    // 4. Все salary_adjustments для Петривой за Май
    console.log('\n--- Детализация: все salary_adjustments для emp_id=5 за Май ---');
    await exec(conn, Q(`
        SELECT id, employee_id, amount, description, operation_kind, is_deleted
        FROM salary_adjustments
        WHERE employee_id = 5 AND month_str = '2026-05'
        ORDER BY id
    `));

    // 5. Проверим: есть ли где-то counterparty-linked transactions, не попавшие в employee_id
    console.log('\n--- Транзакции через counterparty (для всех emp) за Май ---');
    await exec(conn, Q(`
        SELECT t.id, cp.employee_id, e.full_name, t.amount, t.transaction_type, t.system_type, t.description, t.transaction_date::date
        FROM transactions t
        JOIN counterparties cp ON t.counterparty_id = cp.id
        WHERE cp.employee_id IS NOT NULL
          AND t.employee_id IS NULL
          AND t.transaction_date >= '2026-05-01' AND t.transaction_date < '2026-06-01'
          AND COALESCE(t.is_deleted, false) = false
          AND (t.source_module='salary' OR t.system_type LIKE 'salary_%' OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП'))
        ORDER BY cp.employee_id, t.transaction_date
    `));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
