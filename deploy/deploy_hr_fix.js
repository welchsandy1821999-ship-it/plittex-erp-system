#!/usr/bin/env node
const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();
const HR_FILE = 'C:\\\\Users\\\\Пользователь\\\\Desktop\\\\plittex-erp\\\\routes\\\\hr.js';

conn.on('ready', () => {
    console.log('--- UPLOADING hr.js ---');
    conn.sftp((err, sftp) => {
        if (err) throw err;
        
        const readStream = fs.createReadStream(HR_FILE);
        const writeStream = sftp.createWriteStream('/root/plittex-erp/routes/hr.js');
        
        writeStream.on('close', () => {
            console.log('Upload completed. Restarting PM2...');
            conn.exec('cd /root/plittex-erp && pm2 restart ecosystem.config.js', (err, stream) => {
                if (err) throw err;
                stream.on('data', d => process.stdout.write(d.toString()));
                stream.stderr.on('data', d => process.stdout.write('[E] ' + d.toString()));
                stream.on('close', () => {
                    console.log('PM2 Restarted.');
                    conn.end();
                });
            });
        });
        
        readStream.pipe(writeStream);
    });
}).on('error', e => console.error('SSH error:', e)).connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
