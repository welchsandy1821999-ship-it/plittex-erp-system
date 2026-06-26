#!/usr/bin/env node
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
    console.log('=== ФИНАЛЬНАЯ ВЕРИФИКАЦИЯ ===\n');

    for (const monthStr of ['2026-04', '2026-05', '2026-06']) {
        console.log(`\n--- ± Остаток на начало ${monthStr} ---`);
        await exec(conn, Q(`
            SELECT e.id, e.full_name,
                COALESCE(
                    (SELECT SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE -t.amount END)
                     FROM transactions t
                     LEFT JOIN counterparties cp ON t.counterparty_id = cp.id
                     WHERE (t.employee_id = e.id OR cp.employee_id = e.id)
                       AND (
                           t.source_module = 'salary'
                           OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_legacy_action')
                           OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков')
                       )
                       AND COALESCE(t.system_type, '') NOT IN ('salary_period_adjustment', 'salary_adjustment_cash_in', 'salary_adjustment_cash_out')
                       AND t.transaction_date <= ('${monthStr}' || '-01')::timestamp
                       AND COALESCE(t.is_deleted, false) = false
                    ), 0
                )
                +
                COALESCE(
                    (SELECT SUM(sa.amount)
                     FROM salary_adjustments sa
                     WHERE sa.employee_id = e.id
                       AND sa.month_str < '${monthStr}'
                       AND COALESCE(sa.is_deleted, false) = false
                    ), 0
                ) AS prev_balance
            FROM employees e
            WHERE e.status = 'active'
            ORDER BY e.id
        `));
    }

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
