#!/usr/bin/env node
// deploy_inventory_fix2.js — деплой второго исправления в inventory.js

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

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
    console.log('✅ Connected\n');

    // Upload inventory.js
    const sftp = await new Promise((res, rej) => conn.sftp((e, s) => e ? rej(e) : res(s)));
    const local = path.join(__dirname, '..', 'routes', 'inventory.js');
    const remote = '/root/plittex-erp/routes/inventory.js';
    
    await new Promise((res, rej) => {
        console.log('⬆  Uploading inventory.js...');
        sftp.fastPut(local, remote, {}, err => err ? rej(err) : res());
    });
    console.log('✅ inventory.js uploaded\n');

    // Verify the fix is there
    console.log('🔍 Verifying fixes in deployed file...');
    await exec(conn, "grep -n 'LOWER.*TRIM.*name.*is_deleted' /root/plittex-erp/routes/inventory.js 2>&1");
    await exec(conn, "grep -n 'default_warehouse_id' /root/plittex-erp/routes/inventory.js | grep 'INSERT INTO items' | head -5 2>&1");

    // Restart PM2
    console.log('\n🔄 Restarting PM2...');
    await exec(conn, 'pm2 restart plittex-erp && sleep 2 && pm2 status 2>&1');

    conn.end();
    console.log('\n🚀 Done!');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
