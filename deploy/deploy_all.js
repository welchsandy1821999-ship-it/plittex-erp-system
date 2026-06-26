#!/usr/bin/env node
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const BASE = 'C:\\Users\\Пользователь\\Desktop\\plittex-erp';

const files = [
    { local: 'routes/hr.js', remote: '/root/plittex-erp/routes/hr.js' },
    { local: 'routes/dictionaries.js', remote: '/root/plittex-erp/routes/dictionaries.js' },
    { local: 'routes/finance.js', remote: '/root/plittex-erp/routes/finance.js' },
    { local: 'public/js/salary.js', remote: '/root/plittex-erp/public/js/salary.js' },
    { local: 'public/js/finance.js', remote: '/root/plittex-erp/public/js/finance.js' },
    { local: 'public/css/modules.css', remote: '/root/plittex-erp/public/css/modules.css' },
    { local: 'views/modules/salary.ejs', remote: '/root/plittex-erp/views/modules/salary.ejs' },
];

function uploadFile(sftp, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        console.log(`  ↑ ${path.basename(localPath)} → ${remotePath}`);
        const rs = fs.createReadStream(localPath);
        const ws = sftp.createWriteStream(remotePath);
        ws.on('close', resolve);
        ws.on('error', reject);
        rs.pipe(ws);
    });
}

conn.on('ready', () => {
    console.log('=== DEPLOYING FILES ===\n');
    conn.sftp(async (err, sftp) => {
        if (err) throw err;
        for (const f of files) {
            await uploadFile(sftp, path.join(BASE, f.local), f.remote);
        }
        console.log('\nAll files uploaded. Restarting PM2...');
        conn.exec('cd /root/plittex-erp && pm2 restart ecosystem.config.js', (err, stream) => {
            if (err) throw err;
            stream.on('data', d => process.stdout.write(d.toString()));
            stream.stderr.on('data', d => process.stdout.write('[E] ' + d.toString()));
            stream.on('close', () => {
                console.log('PM2 Restarted.\n=== DONE ===');
                conn.end();
            });
        });
    });
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
