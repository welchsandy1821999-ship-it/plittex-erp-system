'use strict';
/**
 * Уровень 2: пересчёт qty_production по формуле дефицита и полная пересборка planned_production.
 *
 * qty_production = GREATEST(qty_ordered - qty_shipped - qty_reserved, 0)
 * только для заказов pending/processing, не удалённых.
 *
 * Запуск: node scripts/fix_qty_production_math.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
});

const ACTIVE_ORDER_FILTER = `
    co.status IN ('pending', 'processing')
    AND COALESCE(co.is_deleted, false) = false
`;

(async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const recalcRes = await client.query(`
            UPDATE client_order_items coi
            SET qty_production = GREATEST(
                COALESCE(coi.qty_ordered, 0) - COALESCE(coi.qty_shipped, 0) - COALESCE(coi.qty_reserved, 0),
                0
            )
            FROM client_orders co
            WHERE coi.order_id = co.id
              AND ${ACTIVE_ORDER_FILTER}
        `);
        const recalculatedRows = Number(recalcRes.rowCount || 0);

        const ppBeforeRes = await client.query('SELECT COUNT(*)::int AS cnt FROM planned_production');
        const ppBeforeCount = Number(ppBeforeRes.rows[0]?.cnt || 0);

        const deletedRes = await client.query('DELETE FROM planned_production');
        const deletedCount = Number(deletedRes.rowCount || 0);

        const createdAtColRes = await client.query(`
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'planned_production'
              AND column_name = 'created_at'
            LIMIT 1
        `);
        const hasCreatedAt = createdAtColRes.rows.length > 0;

        const insertSql = hasCreatedAt
            ? `
            INSERT INTO planned_production (order_item_id, item_id, quantity, created_at)
            SELECT
                coi.id,
                coi.item_id,
                COALESCE(coi.qty_production, 0)::numeric,
                NOW()
            FROM client_order_items coi
            JOIN client_orders co ON coi.order_id = co.id
            WHERE COALESCE(coi.qty_production, 0) > 0.0001
              AND ${ACTIVE_ORDER_FILTER}
        `
            : `
            INSERT INTO planned_production (order_item_id, item_id, quantity)
            SELECT
                coi.id,
                coi.item_id,
                COALESCE(coi.qty_production, 0)::numeric
            FROM client_order_items coi
            JOIN client_orders co ON coi.order_id = co.id
            WHERE COALESCE(coi.qty_production, 0) > 0.0001
              AND ${ACTIVE_ORDER_FILTER}
        `;

        const insertRes = await client.query(insertSql);
        const insertedCount = Number(insertRes.rowCount || 0);

        await client.query('COMMIT');

        console.log('[fix_qty_production_math] Математический пересчёт qty_production выполнен успешно.');
        console.log('[fix_qty_production_math] Обновлено строк client_order_items (активные заказы):', recalculatedRows);
        console.log('[fix_qty_production_math] MRP-план (planned_production) пересобран успешно.');
        console.log('[fix_qty_production_math] Удалено строк planned_production:', deletedCount, '(было:', ppBeforeCount + ')');
        console.log('[fix_qty_production_math] Вставлено строк planned_production:', insertedCount);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[fix_qty_production_math] Ошибка:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
})();
