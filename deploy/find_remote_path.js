#!/usr/bin/env node
// find_remote_path.js — ищет расположение файлов на сервере

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
    console.log('Connected!\n');
    await exec(conn, 'find / -name "dictionaries.js" -path "*/routes/*" 2>/dev/null | head -5');
    console.log('\n---');
    await exec(conn, 'pm2 list 2>/dev/null || echo "no pm2"');
    console.log('\n---');
    await exec(conn, 'ls /var/www/ 2>/dev/null');
    console.log('\n---');
    await exec(conn, 'ps aux | grep node | grep -v grep | head -5');
    conn.end();
}).on('error', e => console.error(e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
