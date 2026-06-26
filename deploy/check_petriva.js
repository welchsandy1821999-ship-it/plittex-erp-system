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
    // Все активные транзакции Петривой (id=5) что попадают в новый фильтр (БЕЗ salary_period_adjustment)
    console.log('--- Все транзакции Петривой (id=5) в новом фильтре ---');
    await exec(conn, Q(`
        SELECT t.id, t.amount, t.transaction_type, t.system_type, t.source_module, t.category, t.transaction_date::date, t.description
        FROM transactions t
        LEFT JOIN counterparties cp ON t.counterparty_id = cp.id
        WHERE (t.employee_id = 5 OR cp.employee_id = 5)
          AND (
              t.source_module = 'salary'
              OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_legacy_action')
              OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков')
          )
          AND t.system_type IS DISTINCT FROM 'salary_period_adjustment'
          AND t.transaction_date <= '2026-06-01'::timestamp
          AND COALESCE(t.is_deleted, false) = false
        ORDER BY t.transaction_date, t.id
    `));

    // Проверим transaction 16355
    console.log('\n--- Статус транзакции 16355 ---');
    await exec(conn, Q(`SELECT id, amount, transaction_type, system_type, source_module, category, is_deleted, description FROM transactions WHERE id = 16355`));

    // salary_adjustments Петривой до июня
    console.log('\n--- salary_adjustments Петривой до 2026-06 ---');
    await exec(conn, Q(`SELECT id, amount, month_str, description, is_deleted FROM salary_adjustments WHERE employee_id = 5 AND month_str < '2026-06' AND COALESCE(is_deleted,false) = false`));

    conn.end();
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
