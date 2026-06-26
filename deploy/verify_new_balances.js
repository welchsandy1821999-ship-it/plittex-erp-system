#!/usr/bin/env node
// verify_new_balances.js — проверка нового расчёта балансов через API

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

conn.on('ready', async () => {
    console.log('=== ПРОВЕРКА НОВОГО API БАЛАНСОВ ===\n');

    // Вызываем API для каждого месяца
    for (const [y, m] of [['2026', '03'], ['2026', '04'], ['2026', '05'], ['2026', '06']]) {
        console.log(`\n--- Баланс на начало ${y}-${m} (через API) ---`);
        const resp = await exec(conn, `curl -s http://localhost:3000/api/salary/balances?year=${y}\\&month=${m}`);
        try {
            const data = JSON.parse(resp);
            console.log('emp_id | name                | prev_balance');
            console.log('-------+---------------------+-------------');
            data.sort((a, b) => a.id - b.id).forEach(e => {
                console.log(`${String(e.id).padStart(6)} | ${e.full_name.padEnd(19)} | ${Number(e.prev_balance).toFixed(2)}`);
            });
        } catch (e) {
            console.log('Ошибка парсинга:', resp.substring(0, 200));
        }
    }

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
