#!/usr/bin/env node
// check_prod_tasks.js — проверяем статус всех задач на продакшн (TCP auth)

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

// Используем -h 127.0.0.1 для TCP-подключения (обходит peer auth)
const Q = (sql) => `PGPASSWORD='ERP_secret_2026' psql -U plittex -h 127.0.0.1 -d plittex_erp -c "${sql.replace(/"/g, '\\"')}" 2>&1`;

conn.on('ready', async () => {
    console.log('=== ПРОВЕРКА ЗАДАЧ НА ПРОДАКШН ===\n');

    console.log('--- Задача 1+2: id=609 (категория) и id=620 (mold_id) ---');
    await exec(conn, Q('SELECT id, name, category, mold_id, default_warehouse_id FROM items WHERE id IN (609, 620);'));

    console.log('\n--- Задача 3: Цены 2-сорта >= 1-сорта ---');
    await exec(conn, Q("SELECT s2.id, s2.name, s2.current_price AS p2, s1.current_price AS p1 FROM items s2 JOIN items s1 ON LOWER(TRIM(s2.name)) = LOWER(TRIM(s1.name)) || ' 2 сорт' WHERE s2.is_deleted=false AND s1.is_deleted=false AND s2.current_price >= s1.current_price ORDER BY s2.id;"));

    console.log('\n--- Задача 4: Активные заказы на 2-сорт с NULL stock_source_warehouse_id ---');
    await exec(conn, Q("SELECT co.doc_number, co.status, i.name, coi.stock_source_warehouse_id FROM client_order_items coi JOIN client_orders co ON co.id=coi.order_id JOIN items i ON i.id=coi.item_id WHERE co.status IN ('pending','processing') AND coi.stock_source_warehouse_id IS NULL AND i.name ILIKE '%2 сорт%' LIMIT 10;"));

    console.log('\n--- Задача 9: Индекс на LOWER(name) ---');
    await exec(conn, Q("SELECT indexname FROM pg_indexes WHERE tablename='items' AND indexdef ILIKE '%lower%';"));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
