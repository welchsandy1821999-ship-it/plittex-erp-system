#!/usr/bin/env node
// deploy_tasks_5689.js — деплой задач 5,6,8,9

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const HOST = '159.194.207.6';
const REMOTE_DIR = '/root/plittex-erp';

const filesToUpload = [
    { local: path.join(__dirname, '..', 'routes', 'inventory.js'), remote: `${REMOTE_DIR}/routes/inventory.js` },
    { local: path.join(__dirname, '..', 'routes', 'sales.js'),     remote: `${REMOTE_DIR}/routes/sales.js` }
];

// SQL для задач 8 и 9
const SQL = `
BEGIN;

-- Задача 8: Заполнить dealer_price у 2-сорта (50% от dealer_price 1-сорта)
UPDATE items s2
SET dealer_price = ROUND(s1.dealer_price * 0.5, 0)
FROM items s1
WHERE LOWER(TRIM(s2.name)) = LOWER(TRIM(s1.name)) || ' 2 сорт'
  AND s2.is_deleted = false
  AND s1.is_deleted = false
  AND s1.dealer_price > 0
  AND (s2.dealer_price IS NULL OR s2.dealer_price = 0);

-- Задача 9: Уникальный индекс на LOWER(TRIM(name)) для предотвращения дублей
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_lower_trim_name
    ON items (LOWER(TRIM(name)))
    WHERE is_deleted = false;

COMMIT;

-- Проверка
SELECT 'dealer_price fixed' AS task, COUNT(*) AS cnt
FROM items WHERE name ILIKE '%2 сорт%' AND dealer_price > 0 AND is_deleted = false;

SELECT 'index created' AS task, indexname
FROM pg_indexes WHERE tablename='items' AND indexname='idx_items_lower_trim_name';
`;

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

function getSftp(conn) {
    return new Promise((res, rej) => conn.sftp((err, sftp) => err ? rej(err) : res(sftp)));
}

function uploadFile(sftp, localPath, remotePath) {
    return new Promise((res, rej) => {
        console.log(`  ⬆  ${path.basename(localPath)}`);
        sftp.fastPut(localPath, remotePath, {}, err => err ? rej(err) : res());
    });
}

async function main() {
    const conn = new Client();
    await new Promise((res, rej) => conn.on('ready', res).on('error', rej)
        .connect({ host: HOST, port: 22, username: 'root', password: '+JjJWwaK5+6b' }));
    console.log('✅ SSH connected\n');

    // 1. Загружаем файлы (задачи 5 и 6)
    const sftp = await getSftp(conn);
    console.log('📁 Uploading inventory.js + sales.js (tasks 5,6)...');
    for (const f of filesToUpload) await uploadFile(sftp, f.local, f.remote);
    console.log('✅ Code uploaded\n');

    // 2. SQL для задач 8 и 9
    console.log('🗄  Running SQL tasks 8,9...');
    await exec(conn, `cat > /tmp/tasks89.sql << 'EOF'\n${SQL}\nEOF`);
    await exec(conn, `PGPASSWORD='ERP_secret_2026' psql -U plittex -h 127.0.0.1 -d plittex_erp -f /tmp/tasks89.sql 2>&1`);

    // 3. Перезапуск PM2
    console.log('\n🔄 Restarting PM2...');
    await exec(conn, 'pm2 restart plittex-erp && sleep 2 && pm2 status 2>&1');

    conn.end();
    console.log('\n🚀 Tasks 5,6,8,9 done!');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
