#!/usr/bin/env node
// migrate_transactions_exclude.js — добавляем exclude_from_salary в transactions

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
    console.log('=== МИГРАЦИЯ: transactions.exclude_from_salary ===\n');

    // 1. Добавляем колонку
    await exec(conn, Q(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS exclude_from_salary BOOLEAN DEFAULT false`));

    // 2. Помечаем все транзакции Выхватенко (employee_id 24, 25) или через counterparty
    console.log('\n2. Помечаем транзакции Выхватенко...');
    await exec(conn, Q(`
        UPDATE transactions SET exclude_from_salary = true
        WHERE (
            employee_id IN (24, 25)
            OR counterparty_id IN (SELECT id FROM counterparties WHERE employee_id IN (24, 25))
        )
        AND COALESCE(is_deleted, false) = false
    `));

    // 3. Проверка
    console.log('\n3. Помечено транзакций:');
    await exec(conn, Q(`SELECT COUNT(*) as cnt FROM transactions WHERE exclude_from_salary = true`));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
