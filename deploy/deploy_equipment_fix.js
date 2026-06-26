#!/usr/bin/env node
// deploy_equipment_fix.js — загружает только исправленные файлы и перезапускает сервер

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const REMOTE_HOST = '159.194.207.6';
const REMOTE_USER = 'root';
const REMOTE_PASS = '+JjJWwaK5+6b';
const REMOTE_DIR = '/var/www/plittex';

const filesToUpload = [
    {
        local: path.join(__dirname, '..', 'routes', 'dictionaries.js'),
        remote: `${REMOTE_DIR}/routes/dictionaries.js`
    },
    {
        local: path.join(__dirname, '..', 'public', 'js', 'equipment.js'),
        remote: `${REMOTE_DIR}/public/js/equipment.js`
    }
];

function exec(conn, cmd) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let out = '';
            stream.on('data', d => { process.stdout.write(d.toString()); out += d; });
            stream.stderr.on('data', d => { process.stdout.write('[ERR] ' + d.toString()); });
            stream.on('close', code => resolve({ code, out }));
        });
    });
}

function getSftp(conn) {
    return new Promise((resolve, reject) => conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp)));
}

function uploadFile(sftp, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        console.log(`  Uploading ${path.basename(localPath)} → ${remotePath}`);
        sftp.fastPut(localPath, remotePath, {}, err => err ? reject(err) : resolve());
    });
}

async function main() {
    const conn = new Client();

    await new Promise((resolve, reject) => {
        conn.on('ready', resolve).on('error', reject)
            .connect({ host: REMOTE_HOST, port: 22, username: REMOTE_USER, password: REMOTE_PASS });
    });

    console.log('✅ SSH connected to', REMOTE_HOST);

    const sftp = await getSftp(conn);

    for (const f of filesToUpload) {
        await uploadFile(sftp, f.local, f.remote);
    }
    console.log('✅ Files uploaded');

    // Перезапускаем сервер через pm2 или systemctl
    console.log('\n🔄 Restarting server...');
    const r1 = await exec(conn, 'pm2 restart plittex 2>&1 || pm2 restart all 2>&1 || systemctl restart plittex 2>&1 || echo "RESTART_FAILED"');
    
    if (r1.out.includes('RESTART_FAILED') || r1.out.includes('not found')) {
        console.log('⚠️  pm2/systemctl не найден, пробуем killall + запуск...');
        await exec(conn, `cd ${REMOTE_DIR} && killall node; sleep 1; nohup node server.js > /tmp/plittex.log 2>&1 &`);
    }

    console.log('\n🔍 Server process check:');
    await exec(conn, 'ps aux | grep node | grep -v grep');

    console.log('\n🔍 Port 3000 check:');
    await exec(conn, 'ss -tlnp | grep 3000 || netstat -tlnp | grep 3000 || echo "port check failed"');

    conn.end();
    console.log('\n✅ Deploy complete!');
}

main().catch(err => {
    console.error('❌ Deploy failed:', err.message);
    process.exit(1);
});
