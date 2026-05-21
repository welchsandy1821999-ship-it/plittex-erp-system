'use strict';
/**
 * Свёртка «шумовых» проводок авто-ребаланса (готовая + резерв) в одну пару на группу.
 * Только description ILIKE '%Авто-ребаланс%' и без «Свернуто», склады по type finished/reserve.
 * Валидация перед COMMIT: движения резерва по coi vs qty_reserved (pending/processing), Δ > 0.01 → ROLLBACK.
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

function roundQty(n) {
    return Math.round(Number(n) * 10000) / 10000;
}

(async () => {
    const client = await pool.connect();
    let deletedRows = 0;
    let insertedPairs = 0;

    try {
        const whRes = await client.query(
            `SELECT id, type FROM warehouses WHERE type IN ('finished','reserve')`
        );
        const finRow = whRes.rows.find((r) => r.type === 'finished');
        const resRow = whRes.rows.find((r) => r.type === 'reserve');
        if (!finRow || !resRow) throw new Error('Склады finished/reserve не найдены');
        const finishedWhId = finRow.id;
        const reserveWhId = resRow.id;

        await client.query('BEGIN');

        const agg = await client.query(
            `
            WITH noise AS (
                SELECT m.id,
                       m.item_id,
                       m.linked_order_item_id,
                       m.batch_id,
                       m.quantity,
                       m.warehouse_id
                FROM inventory_movements m
                WHERE m.warehouse_id IN ($1::int, $2::int)
                  AND m.movement_type IN ('reserve_expense', 'reserve_receipt')
                  AND m.description ILIKE '%Авто-ребаланс%'
                  AND m.description NOT ILIKE '%Свернуто%'
            )
            SELECT n.item_id,
                   n.linked_order_item_id,
                   n.batch_id,
                   COALESCE(SUM(n.quantity) FILTER (WHERE n.warehouse_id = $2::int), 0)::numeric AS delta_res,
                   COALESCE(SUM(n.quantity) FILTER (WHERE n.warehouse_id = $1::int), 0)::numeric AS delta_fin,
                   COUNT(*)::int AS row_cnt,
                   array_agg(n.id ORDER BY n.id) AS ids
            FROM noise n
            GROUP BY n.item_id, n.linked_order_item_id, n.batch_id
            `,
            [finishedWhId, reserveWhId]
        );

        for (const g of agg.rows) {
            const ids = g.ids.filter((id) => id != null);
            if (!ids.length) continue;

            await client.query(`DELETE FROM inventory_movements WHERE id = ANY($1::int[])`, [ids]);
            deletedRows += ids.length;

            const deltaRes = roundQty(g.delta_res);
            const deltaFin = roundQty(g.delta_fin);
            if (Math.abs(deltaRes + deltaFin) > 0.05) {
                console.warn(
                    `[compress] группа item=${g.item_id} coi=${g.linked_order_item_id} batch=${g.batch_id}: ` +
                        `Δ_res=${deltaRes} Δ_fin=${deltaFin} (ожидалось зеркало)`
                );
            }

            if (deltaRes <= 0.0001) continue;

            const qty = deltaRes;
            const descExpense = `Авто-ребаланс резерва (Свернуто)`;
            const descReceipt = `Авто-ребаланс резерва (Свернуто)`;

            await client.query(
                `INSERT INTO inventory_movements
                     (item_id, quantity, movement_type, description, warehouse_id, batch_id, linked_order_item_id)
                 VALUES ($1, $2, 'reserve_expense', $3, $4, $5, $6)`,
                [g.item_id, -qty, descExpense, finishedWhId, g.batch_id, g.linked_order_item_id]
            );
            await client.query(
                `INSERT INTO inventory_movements
                     (item_id, quantity, movement_type, description, warehouse_id, batch_id, linked_order_item_id)
                 VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6)`,
                [g.item_id, qty, descReceipt, reserveWhId, g.batch_id, g.linked_order_item_id]
            );
            insertedPairs += 1;
        }

        const check = await client.query(
            `
            WITH mv AS (
                SELECT m.linked_order_item_id AS coi_id,
                       COALESCE(SUM(m.quantity), 0)::numeric AS bal_reserve
                FROM inventory_movements m
                WHERE m.warehouse_id = $1
                  AND m.linked_order_item_id IS NOT NULL
                GROUP BY m.linked_order_item_id
            )
            SELECT COUNT(*)::int AS mismatches
            FROM client_order_items coi
            JOIN client_orders co ON co.id = coi.order_id
            LEFT JOIN mv ON mv.coi_id = coi.id
            WHERE co.status IN ('pending', 'processing')
              AND ABS(COALESCE(mv.bal_reserve, 0) - COALESCE(coi.qty_reserved, 0)) > 0.01
            `,
            [reserveWhId]
        );

        const mismatches = check.rows[0].mismatches;
        if (mismatches > 0) {
            await client.query('ROLLBACK');
            console.error(
                `[compress] ROLLBACK: расхождения резерв vs qty_reserved (${mismatches} позиций) > 0.01`
            );
            process.exitCode = 1;
            return;
        }

        await client.query('COMMIT');
        console.log('[compress] COMMIT выполнен.');
        console.log(JSON.stringify({ deletedRows, insertedPairs, netNewRows: insertedPairs * 2 }, null, 2));
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(e);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
})();
