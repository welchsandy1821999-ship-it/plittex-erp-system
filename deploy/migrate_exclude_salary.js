#!/usr/bin/env node
// migrate_exclude_salary.js — добавляем поле exclude_from_salary в employees

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
    console.log('=== МИГРАЦИЯ: exclude_from_salary ===\n');

    // 1. Добавляем колонку
    console.log('1. ALTER TABLE...');
    await exec(conn, Q(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS exclude_from_salary BOOLEAN DEFAULT false`));

    // 2. Включаем для Выхватенко
    console.log('\n2. Включаем для Выхватенко...');
    await exec(conn, Q(`UPDATE employees SET exclude_from_salary = true WHERE id IN (24, 25)`));

    // 3. Проверка
    console.log('\n3. Проверка...');
    await exec(conn, Q(`SELECT id, full_name, exclude_from_salary FROM employees WHERE exclude_from_salary = true`));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
