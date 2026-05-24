'use strict';
/**
 * Полная пересборка planned_production из актуального qty_production по активным заказам.
 * Устраняет фантомные строки от completed/cancelled/deleted заказов и рассинхрон с coi.
 *
 * Запуск: node scripts/sync_planned_production.js
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

        const beforeRes = await client.query('SELECT COUNT(*)::int AS cnt FROM planned_production');
        const beforeCount = Number(beforeRes.rows[0]?.cnt || 0);

        const validRes = await client.query(`
            SELECT COUNT(*)::int AS cnt
            FROM client_order_items coi
            JOIN client_orders co ON coi.order_id = co.id
            WHERE COALESCE(coi.qty_production, 0) > 0.0001
              AND ${ACTIVE_ORDER_FILTER}
        `);
        const validTargetCount = Number(validRes.rows[0]?.cnt || 0);
        const phantomCount = Math.max(0, beforeCount - validTargetCount);

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

        console.log('[sync_planned_production] Строк в planned_production до очистки:', beforeCount);
        console.log('[sync_planned_production] Целевых активных строк (qty_production > 0):', validTargetCount);
        console.log('[sync_planned_production] Удалено записей (всего):', deletedCount);
        console.log('[sync_planned_production] Удалено фантомных записей (оценка):', phantomCount);
        console.log('[sync_planned_production] Вставлено актуальных записей:', insertedCount);

        const afterRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM planned_production');
        console.log('[sync_planned_production] Строк после синхронизации:', afterRes.rows[0]?.cnt ?? 0);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[sync_planned_production] Ошибка:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
})();
