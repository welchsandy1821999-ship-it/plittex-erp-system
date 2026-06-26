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
    // Найти ВСЕ уникальные system_type для adjustment-подобных транзакций
    console.log('--- Все system_types содержащие "adjustment" ---');
    await exec(conn, Q(`SELECT DISTINCT system_type FROM transactions WHERE system_type LIKE '%adjust%' OR system_type LIKE '%salary_adj%' ORDER BY system_type`));

    // Все system_types вообще, которые связаны с salary
    console.log('\n--- Все salary system_types ---');
    await exec(conn, Q(`SELECT DISTINCT system_type, COUNT(*) FROM transactions WHERE source_module = 'salary' OR system_type LIKE 'salary_%' GROUP BY system_type ORDER BY system_type`));

    conn.end();
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
