#!/usr/bin/env node
// deploy_all_fixes.js — деплой всех исправлений на продакшн

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const HOST = '159.194.207.6';
const USER = 'root';
const PASS = '+JjJWwaK5+6b';
const REMOTE_DIR = '/root/plittex-erp';

// Файлы для загрузки
const filesToUpload = [
    { local: path.join(__dirname, '..', 'routes', 'dictionaries.js'),  remote: `${REMOTE_DIR}/routes/dictionaries.js` },
    { local: path.join(__dirname, '..', 'public', 'js', 'equipment.js'), remote: `${REMOTE_DIR}/public/js/equipment.js` }
];

// SQL миграции для продакшн БД (все исправления 2-сорта)
const SQL_MIGRATION = `
-- =====================================================================
-- ПРОДАКШН МИГРАЦИЯ: Все исправления 2-сорта от 17-18.06.2026
-- Безопасно: каждый UPDATE имеет WHERE условие, повторный запуск безвреден
-- =====================================================================

BEGIN;

-- 1. Установить default_warehouse_id для 2-сорта → склад markdown
UPDATE items
SET default_warehouse_id = (SELECT id FROM warehouses WHERE type = 'markdown' LIMIT 1)
WHERE (name ILIKE '%2 сорт%' OR name ILIKE '%2сорт%' OR name ILIKE '%уценка%')
  AND is_deleted = false
  AND (default_warehouse_id IS NULL OR default_warehouse_id NOT IN (SELECT id FROM warehouses WHERE type = 'markdown'));

-- 2. Установить default_warehouse_id для 1-сорта → склад finished
UPDATE items
SET default_warehouse_id = (SELECT id FROM warehouses WHERE type = 'finished' LIMIT 1)
WHERE name NOT ILIKE '%2 сорт%'
  AND name NOT ILIKE '%2сорт%'
  AND name NOT ILIKE '%уценка%'
  AND is_deleted = false
  AND category IN (
    'Бордюры и поребрики','Плитка гладкая','Плитка гранитная',
    'Плитка меланж гладкая','Плитка меланж гранит'
  )
  AND (default_warehouse_id IS NULL OR default_warehouse_id NOT IN (SELECT id FROM warehouses WHERE type = 'finished'));

-- 3. Заполнить пустые поля 2-сорта из 1-сорта (weight, qty, mold, gost, mix)
UPDATE items s2
SET
    weight_kg     = CASE WHEN s2.weight_kg = 0 THEN s1.weight_kg ELSE s2.weight_kg END,
    qty_per_cycle = CASE WHEN s2.qty_per_cycle = 1 AND s1.qty_per_cycle != 1 THEN s1.qty_per_cycle ELSE s2.qty_per_cycle END,
    mold_id       = CASE WHEN s2.mold_id IS NULL THEN s1.mold_id ELSE s2.mold_id END,
    gost_mark     = CASE WHEN s2.gost_mark IS NULL OR s2.gost_mark = '' THEN s1.gost_mark ELSE s2.gost_mark END,
    mix_main_tpl  = CASE WHEN s2.mix_main_tpl IS NULL OR s2.mix_main_tpl = '' THEN s1.mix_main_tpl ELSE s2.mix_main_tpl END,
    mix_face_tpl  = CASE WHEN s2.mix_face_tpl IS NULL OR s2.mix_face_tpl = '' THEN s1.mix_face_tpl ELSE s2.mix_face_tpl END,
    article       = CASE WHEN (s2.article IS NULL OR s2.article = '') AND s1.article IS NOT NULL THEN s1.article || '2S' ELSE s2.article END
FROM items s1
WHERE LOWER(TRIM(s2.name)) = LOWER(TRIM(s1.name)) || ' 2 сорт'
  AND s1.is_deleted = false
  AND s2.is_deleted = false
  AND (
      s2.weight_kg = 0 OR s2.qty_per_cycle = 1
      OR s2.mold_id IS NULL
      OR s2.gost_mark IS NULL OR s2.gost_mark = ''
      OR s2.mix_main_tpl IS NULL OR s2.mix_main_tpl = ''
  );

-- 4. Создать недостающие позиции 2-сорта (если их нет)
INSERT INTO items (
    name, item_type, unit, current_price, weight_kg, category,
    qty_per_cycle, amortization_per_cycle, mold_id, gost_mark, article,
    dealer_price, is_deleted, piece_rate,
    mix_main_tpl, mix_face_tpl, min_stock, default_warehouse_id
)
SELECT
    TRIM(s1.name) || ' 2 сорт',
    s1.item_type, s1.unit,
    ROUND(s1.current_price * 0.50, 0),
    s1.weight_kg, s1.category,
    s1.qty_per_cycle, s1.amortization_per_cycle, s1.mold_id, s1.gost_mark,
    CASE WHEN s1.article IS NOT NULL AND s1.article != '' THEN s1.article || '2S' ELSE NULL END,
    0, false, s1.piece_rate,
    s1.mix_main_tpl, s1.mix_face_tpl, s1.min_stock,
    (SELECT id FROM warehouses WHERE type = 'markdown' LIMIT 1)
FROM items s1
WHERE NOT EXISTS (
    SELECT 1 FROM items s2
    WHERE LOWER(TRIM(s2.name)) = LOWER(TRIM(s1.name)) || ' 2 сорт'
      AND s2.is_deleted = false
)
AND s1.category IN (
    'Бордюры и поребрики','Плитка гладкая','Плитка гранитная',
    'Плитка меланж гладкая','Плитка меланж гранит'
)
AND s1.is_deleted = false
AND s1.name NOT ILIKE '%2 сорт%'
AND s1.name NOT ILIKE '%эксперим%';

-- 5. Исправить цены 2-сорта = цене 1-сорта (должно быть 50%)
UPDATE items s2
SET current_price = ROUND(s1.current_price * 0.5, 0)
FROM items s1
WHERE LOWER(TRIM(s2.name)) = LOWER(TRIM(s1.name)) || ' 2 сорт'
  AND s2.is_deleted = false
  AND s1.is_deleted = false
  AND s2.current_price >= s1.current_price;

COMMIT;

-- Итоговая сводка
SELECT
    CASE WHEN name ILIKE '%2 сорт%' THEN '2-sort' ELSE '1-sort' END AS grade,
    default_warehouse_id,
    COUNT(*) AS cnt
FROM items
WHERE is_deleted = false
  AND category IN (
    'Бордюры и поребрики','Плитка гладкая','Плитка гранитная',
    'Плитка меланж гладкая','Плитка меланж гранит'
  )
GROUP BY 1, 2 ORDER BY 1, 2;
`;

function exec(conn, cmd) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let out = '';
            stream.on('data', d => { process.stdout.write(d.toString()); out += d; });
            stream.stderr.on('data', d => process.stdout.write('[ERR] ' + d.toString()));
            stream.on('close', () => resolve(out));
        });
    });
}

function getSftp(conn) {
    return new Promise((resolve, reject) => conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp)));
}

function uploadFile(sftp, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        console.log(`  ⬆  ${path.basename(localPath)} → ${remotePath}`);
        sftp.fastPut(localPath, remotePath, {}, err => err ? reject(err) : resolve());
    });
}

async function main() {
    const conn = new Client();
    await new Promise((res, rej) => conn.on('ready', res).on('error', rej)
        .connect({ host: HOST, port: 22, username: USER, password: PASS }));
    console.log('✅ SSH connected to', HOST);

    // 1. Загрузить файлы
    const sftp = await getSftp(conn);
    console.log('\n📁 Uploading files...');
    for (const f of filesToUpload) await uploadFile(sftp, f.local, f.remote);
    console.log('✅ Files uploaded\n');

    // 2. Записать SQL во временный файл на сервере и выполнить
    console.log('🗄  Running DB migrations on production...');
    // Передаём через heredoc
    const escapedSql = SQL_MIGRATION.replace(/'/g, `'\\''`);
    const sqlFile = '/tmp/plittex_migration.sql';
    await exec(conn, `cat > ${sqlFile} << 'ENDSQL'\n${SQL_MIGRATION}\nENDSQL`);
    
    // Найти параметры БД из .env на сервере
    const envOut = await exec(conn, `grep -E "^DB_" ${REMOTE_DIR}/.env 2>/dev/null || grep -E "^DB_" /root/.env 2>/dev/null`);
    console.log('Remote .env DB vars:', envOut.trim());

    // Парсим из вывода
    const getVar = (name) => { const m = envOut.match(new RegExp(`${name}=(.+)`)); return m ? m[1].trim() : null; };
    const dbUser = getVar('DB_USER') || 'postgres';
    const dbPass = getVar('DB_PASSWORD') || '';
    const dbName = getVar('DB_NAME') || 'plittex_erp';
    const dbHost = getVar('DB_HOST') || 'localhost';

    console.log(`  DB: ${dbUser}@${dbHost}/${dbName}`);
    await exec(conn, `PGPASSWORD='${dbPass}' psql -U ${dbUser} -h ${dbHost} -d ${dbName} -f ${sqlFile} 2>&1`);
    console.log('✅ DB migrations complete\n');

    // 3. Перезапустить PM2
    console.log('🔄 Restarting PM2...');
    await exec(conn, 'pm2 restart plittex-erp 2>&1');
    await new Promise(r => setTimeout(r, 2000));
    await exec(conn, 'pm2 status 2>&1');
    console.log('✅ Server restarted');

    conn.end();
    console.log('\n🚀 All done!');
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
