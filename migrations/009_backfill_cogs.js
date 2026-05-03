'use strict';
/**
 * Backfill: заполнение unit_cost_snapshot для всех существующих client_order_items.
 * Используется текущая себестоимость (компромисс — историческую не восстановить).
 * Запускать ПОСЛЕ миграции 009_add_cogs_snapshot.sql
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { buildSalesAnalyticsUnitCostData } = require('../utils/salesAnalyticsUnitCost');

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST,
    database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT
});

(async () => {
    console.log('=== Backfill COGS Snapshots ===');

    // Получаем overhead из settings
    const overheadRes = await pool.query(`SELECT value FROM settings WHERE key = 'overhead_per_cycle'`);
    const overheadPerCycle = overheadRes.rows.length > 0 ? Number(overheadRes.rows[0].value || 0) : 0;
    console.log(`  overhead_per_cycle = ${overheadPerCycle}`);

    // Все позиции без слепка
    const itemsRes = await pool.query(`
        SELECT DISTINCT item_id FROM client_order_items WHERE unit_cost_snapshot IS NULL
    `);
    const itemIds = itemsRes.rows.map(r => Number(r.item_id));
    console.log(`  Уникальных товаров без слепка: ${itemIds.length}`);

    if (!itemIds.length) {
        console.log('  Все позиции уже заполнены. Выход.');
        await pool.end();
        return;
    }

    // Рассчитываем себестоимость батчами по 50
    const BATCH = 50;
    let updated = 0;
    for (let i = 0; i < itemIds.length; i += BATCH) {
        const batch = itemIds.slice(i, i + BATCH);
        const { unitCostMap } = await buildSalesAnalyticsUnitCostData(pool, batch, {
            includeOverhead: true,
            overheadPerCycle
        });

        for (const [itemId, info] of unitCostMap.entries()) {
            const res = await pool.query(
                `UPDATE client_order_items SET unit_cost_snapshot = $1, cost_source = $2
                 WHERE item_id = $3 AND unit_cost_snapshot IS NULL`,
                [info.unit_cost, info.source, itemId]
            );
            updated += res.rowCount;
        }
        console.log(`  Батч ${Math.floor(i / BATCH) + 1}: обработано ${batch.length} товаров`);
    }

    console.log(`\n✅ Backfill завершён. Обновлено строк: ${updated}`);
    await pool.end();
})().catch(e => { console.error('ОШИБКА:', e.message); pool.end(); process.exit(1); });
