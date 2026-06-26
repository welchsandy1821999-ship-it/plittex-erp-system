#!/usr/bin/env node
// final_verification.js — полная финальная проверка продакшн

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

const PSQ = (sql) => `PGPASSWORD='ERP_secret_2026' psql -U plittex -h 127.0.0.1 -d plittex_erp -c "${sql.replace(/"/g, '\\"')}" 2>&1`;

conn.on('ready', async () => {
    console.log('============================================================');
    console.log('       ФИНАЛЬНАЯ ПРОВЕРКА — ПРОДАКШН erp.plittex.ru');
    console.log('============================================================\n');

    // 1. Склады
    console.log('=== 1. СКЛАДЫ ===');
    await exec(conn, PSQ('SELECT id, name, type FROM warehouses ORDER BY id;'));

    // 2. Распределение default_warehouse_id
    console.log('\n=== 2. default_warehouse_id для продукции (должно быть 4=1сорт, 5=2сорт) ===');
    await exec(conn, PSQ("SELECT CASE WHEN name ILIKE '%2 сорт%' THEN '2-sort' ELSE '1-sort' END AS grade, default_warehouse_id, COUNT(*) AS cnt FROM items WHERE is_deleted=false AND category IN ('Бордюры и поребрики','Плитка гладкая','Плитка гранитная','Плитка меланж гладкая','Плитка меланж гранит') GROUP BY 1,2 ORDER BY 1,2;"));

    // 3. Аномалии: 1-сорт без default_warehouse_id
    console.log('\n=== 3. 1-сорт без default_warehouse_id (должно быть 0) ===');
    await exec(conn, PSQ("SELECT COUNT(*) AS no_warehouse_1sort FROM items WHERE is_deleted=false AND name NOT ILIKE '%2 сорт%' AND category IN ('Бордюры и поребрики','Плитка гладкая','Плитка гранитная','Плитка меланж гладкая','Плитка меланж гранит') AND (default_warehouse_id IS NULL OR default_warehouse_id NOT IN (SELECT id FROM warehouses WHERE type='finished'));"));

    // 4. Аномалии: 2-сорт не на складе 5
    console.log('\n=== 4. 2-сорт не на складе markdown (должно быть 0) ===');
    await exec(conn, PSQ("SELECT COUNT(*) AS bad_2sort FROM items WHERE is_deleted=false AND name ILIKE '%2 сорт%' AND category IN ('Бордюры и поребрики','Плитка гладкая','Плитка гранитная','Плитка меланж гладкая','Плитка меланж гранит') AND (default_warehouse_id IS NULL OR default_warehouse_id NOT IN (SELECT id FROM warehouses WHERE type='markdown'));"));

    // 5. Цены 2-сорта >= 1-сорта
    console.log('\n=== 5. 2-сорт с ценой >= 1-сорта (должно быть 0) ===');
    await exec(conn, PSQ("SELECT COUNT(*) AS overpriced FROM items s2 JOIN items s1 ON LOWER(TRIM(s2.name)) = LOWER(TRIM(s1.name)) || ' 2 сорт' WHERE s2.is_deleted=false AND s1.is_deleted=false AND s2.current_price >= s1.current_price;"));

    // 6. 2-сорт без weight_kg
    console.log('\n=== 6. 2-сорт с weight_kg=0 (исключая УРИКО) ===');
    await exec(conn, PSQ("SELECT id, name, weight_kg FROM items WHERE is_deleted=false AND name ILIKE '%2 сорт%' AND name NOT ILIKE '%УРИКО%' AND weight_kg=0;"));

    // 7. 2-сорт без mold_id
    console.log('\n=== 7. 2-сорт без mold_id (исключая УРИКО) ===');
    await exec(conn, PSQ("SELECT COUNT(*) AS no_mold FROM items WHERE is_deleted=false AND name ILIKE '%2 сорт%' AND name NOT ILIKE '%УРИКО%' AND mold_id IS NULL;"));

    // 8. Движения markdown на неверный склад
    console.log('\n=== 8. markdown_receipt на неверный склад (должно быть 0) ===');
    await exec(conn, PSQ("SELECT COUNT(*) AS bad FROM inventory_movements im JOIN warehouses w ON w.id=im.warehouse_id WHERE im.movement_type='markdown_receipt' AND w.type != 'markdown';"));

    // 9. scrap_receipt на неверный склад
    console.log('\n=== 9. scrap_receipt на неверный склад (должно быть 0) ===');
    await exec(conn, PSQ("SELECT COUNT(*) AS bad FROM inventory_movements im JOIN warehouses w ON w.id=im.warehouse_id WHERE im.movement_type='scrap_receipt' AND w.type != 'defect';"));

    // 10. Активные заказы на 2-сорт с NULL stock_source_warehouse_id
    console.log('\n=== 10. Активные заказы на 2-сорт с NULL warehouse (должно быть 0) ===');
    await exec(conn, PSQ("SELECT COUNT(*) AS bad FROM client_order_items coi JOIN client_orders co ON co.id=coi.order_id JOIN items i ON i.id=coi.item_id WHERE co.status IN ('pending','processing') AND coi.stock_source_warehouse_id IS NULL AND i.name ILIKE '%2 сорт%';"));

    // 11. Индекс на LOWER(name)
    console.log('\n=== 11. Уникальный индекс на name ===');
    await exec(conn, PSQ("SELECT indexname, indexdef FROM pg_indexes WHERE tablename='items' AND indexname='idx_items_lower_trim_name';"));

    // 12. Оборудование — проверка PUT роута (косвенно — смотрим на наличие роута в коде)
    console.log('\n=== 12. Оборудование — наличие POST-алиаса в dictionaries.js ===');
    await exec(conn, "grep -n 'POST.*equipment.*:id' /root/plittex-erp/routes/dictionaries.js | grep -v maintenance 2>&1");

    // 13. Инвентарь — ILIKE в поиске 2-сорта
    console.log('\n=== 13. ILIKE в поиске 2-сорта при распалубке ===');
    await exec(conn, "grep -n 'LOWER.*TRIM.*name.*2.*сорт\\|checkExist' /root/plittex-erp/routes/inventory.js 2>&1 | head -5");

    // 14. Дефицит материалов — фильтр по складу
    console.log('\n=== 14. Фильтр склада в проверке дефицита (sales.js) ===');
    await exec(conn, "grep -n 'type.*materials\\|materials.*warehouse' /root/plittex-erp/routes/sales.js 2>&1 | head -5");

    conn.end();
    console.log('\n============================================================');
    console.log('                    ПРОВЕРКА ЗАВЕРШЕНА');
    console.log('============================================================');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
