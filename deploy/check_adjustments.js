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
    console.log('--- Проверка Adjustments и Legacy Actions ---');
    await exec(conn, Q("SELECT id, amount, transaction_type, system_type, category, transaction_date::date, description, is_deleted FROM transactions WHERE system_type IN ('salary_legacy_action', 'salary_period_adjustment', 'salary_accrual', 'salary_tax_withhold') AND transaction_date >= '2026-04-01' ORDER BY transaction_date, id;"));
    
    console.log('--- Проверка таблицы salary_adjustments ---');
    await exec(conn, Q("SELECT id, amount, month_str, description, is_deleted FROM salary_adjustments WHERE month_str >= '2026-04';"));
    
    conn.end();
}).on('error', e => console.error('SSH error:', e)).connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
