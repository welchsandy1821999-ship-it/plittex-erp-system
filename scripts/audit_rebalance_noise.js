'use strict';
/**
 * Read-only аудит «мусорных» парных движений авто-ребаланса (готовая + резерв).
 * Ничего не удаляет и не изменяет.
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

const AUTO_REB = `m.description ILIKE '%Авто-ребаланс%'`;

(async () => {
    const wh = await pool.query(
        `SELECT id, type, name FROM warehouses WHERE type IN ('finished','reserve') ORDER BY id`
    );
    const fin = wh.rows.find((r) => r.type === 'finished');
    const res = wh.rows.find((r) => r.type === 'reserve');
    if (!fin || !res) throw new Error('Склады finished/reserve не найдены');

    console.log('=== Склады (проверка №4 / резервы) ===');
    console.table(wh.rows);

    const q1 = await pool.query(
        `
        SELECT m.movement_type,
               COUNT(*)::int AS total_rows,
               COUNT(*) FILTER (WHERE m.transaction_id IS NULL)::int AS null_tx_rows,
               COUNT(*) FILTER (WHERE ${AUTO_REB})::int AS auto_rebalance_rows,
               ROUND(SUM(m.quantity)::numeric, 4) AS sum_qty
        FROM inventory_movements m
        WHERE m.warehouse_id IN ($1, $2)
          AND m.movement_type IN (
            'reserve_expense', 'reserve_receipt',
            'reserve_release_expense', 'reserve_release_receipt'
          )
        GROUP BY m.movement_type
        ORDER BY total_rows DESC
    `,
        [fin.id, res.id]
    );
    console.log('\n=== Резервные типы движений (готовая + резерв) ===');
    console.table(q1.rows);

    const q2 = await pool.query(
        `
        SELECT m.item_id,
               i.name AS item_name,
               COUNT(*)::int AS auto_reb_rows,
               ROUND(SUM(m.quantity)::numeric, 4) AS net_qty_both_whs,
               COUNT(*) FILTER (WHERE m.warehouse_id = $1)::int AS rows_on_finished,
               COUNT(*) FILTER (WHERE m.warehouse_id = $2)::int AS rows_on_reserve,
               ROUND(SUM(m.quantity) FILTER (WHERE m.warehouse_id = $1)::numeric, 4) AS net_finished,
               ROUND(SUM(m.quantity) FILTER (WHERE m.warehouse_id = $2)::numeric, 4) AS net_reserve
        FROM inventory_movements m
        JOIN items i ON i.id = m.item_id
        WHERE m.warehouse_id IN ($1, $2)
          AND ${AUTO_REB}
        GROUP BY m.item_id, i.name
        ORDER BY auto_reb_rows DESC
        LIMIT 25
    `,
        [fin.id, res.id]
    );
    console.log('\n=== ТОП-25 товаров по числу строк «Авто-ребаланс» ===');
    console.table(q2.rows);

    const q3 = await pool.query(
        `
        WITH del AS (
            SELECT m.*
            FROM inventory_movements m
            WHERE m.warehouse_id IN ($1, $2)
              AND ${AUTO_REB}
        )
        SELECT d.item_id,
               i.name,
               COALESCE(bf.bal_fin, 0)::numeric AS bal_finished_now,
               COALESCE(br.bal_res, 0)::numeric AS bal_reserve_now,
               ROUND(COALESCE(SUM(d.quantity) FILTER (WHERE d.warehouse_id = $1), 0)::numeric, 4) AS sum_del_on_finished,
               ROUND(COALESCE(SUM(d.quantity) FILTER (WHERE d.warehouse_id = $2), 0)::numeric, 4) AS sum_del_on_reserve,
               ROUND((COALESCE(bf.bal_fin, 0) - COALESCE(SUM(d.quantity) FILTER (WHERE d.warehouse_id = $1), 0))::numeric, 4) AS sim_bal_finished_after_delete,
               ROUND((COALESCE(br.bal_res, 0) - COALESCE(SUM(d.quantity) FILTER (WHERE d.warehouse_id = $2), 0))::numeric, 4) AS sim_bal_reserve_after_delete
        FROM del d
        JOIN items i ON i.id = d.item_id
        LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(quantity), 0)::numeric AS bal_fin
            FROM inventory_movements WHERE item_id = d.item_id AND warehouse_id = $1
        ) bf ON true
        LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(quantity), 0)::numeric AS bal_res
            FROM inventory_movements WHERE item_id = d.item_id AND warehouse_id = $2
        ) br ON true
        GROUP BY d.item_id, i.name, bf.bal_fin, br.bal_res
        ORDER BY COUNT(*) DESC
        LIMIT 15
    `,
        [fin.id, res.id]
    );
    console.log('\n=== Симуляция: удалить ВСЕ строки с «Авто-ребаланс» по товару (топ-15 по объёму шума) ===');
    console.table(q3.rows);

    const q4 = await pool.query(
        `
        SELECT ${AUTO_REB} AS is_auto,
               m.transaction_id IS NULL AS tx_null,
               COUNT(*)::int AS c
        FROM inventory_movements m
        WHERE m.warehouse_id IN ($1, $2)
          AND m.movement_type IN ('reserve_expense', 'reserve_receipt')
        GROUP BY 1, 2
        ORDER BY c DESC
    `,
        [fin.id, res.id]
    );
    console.log('\n=== reserve_expense / reserve_receipt: Авто-ребаланс × transaction_id NULL ===');
    console.table(q4.rows);

    const q5 = await pool.query(
        `
        WITH mv AS (
            SELECT m.linked_order_item_id AS coi_id,
                   COALESCE(SUM(m.quantity), 0)::numeric AS bal_reserve
            FROM inventory_movements m
            WHERE m.warehouse_id = $1
              AND m.linked_order_item_id IS NOT NULL
            GROUP BY m.linked_order_item_id
        )
        SELECT coi.id AS coi_id,
               co.doc_number,
               coi.item_id,
               i.name AS item_name,
               ROUND(COALESCE(coi.qty_reserved, 0)::numeric, 4) AS qty_reserved_in_order,
               ROUND(COALESCE(mv.bal_reserve, 0)::numeric, 4) AS sum_qty_reserve_wh_by_coi,
               ROUND((COALESCE(mv.bal_reserve, 0) - COALESCE(coi.qty_reserved, 0))::numeric, 4) AS delta
        FROM client_order_items coi
        JOIN client_orders co ON co.id = coi.order_id
        JOIN items i ON i.id = coi.item_id
        LEFT JOIN mv ON mv.coi_id = coi.id
        WHERE co.status IN ('pending', 'processing')
          AND ABS(COALESCE(mv.bal_reserve, 0) - COALESCE(coi.qty_reserved, 0)) > 0.01
        ORDER BY ABS(COALESCE(mv.bal_reserve, 0) - COALESCE(coi.qty_reserved, 0)) DESC
        LIMIT 20
    `,
        [res.id]
    );
    console.log('\n=== Расхождения: движения резерва по coi vs client_order_items.qty_reserved (активные заказы) ===');
    console.table(q5.rows);

    const topIds = q2.rows.slice(0, 2).map((r) => r.item_id);
    for (const itemId of topIds) {
        const det = await pool.query(
            `
            SELECT m.id,
                   m.movement_type,
                   w.type AS wh_type,
                   ROUND(m.quantity::numeric, 4) AS qty,
                   m.transaction_id IS NULL AS tx_null,
                   LEFT(m.description, 70) AS descr,
                   to_char(COALESCE(m.movement_date, m.created_at), 'YYYY-MM-DD HH24:MI:SS') AS ts,
                   m.linked_order_item_id,
                   pb.batch_number
            FROM inventory_movements m
            JOIN warehouses w ON w.id = m.warehouse_id
            LEFT JOIN production_batches pb ON pb.id = m.batch_id
            WHERE m.item_id = $1
              AND m.warehouse_id IN ($2, $3)
              AND (
                ${AUTO_REB}
                OR m.movement_type IN ('reserve_release_expense', 'reserve_release_receipt')
              )
            ORDER BY COALESCE(m.movement_date, m.created_at), m.id
            LIMIT 80
        `,
            [itemId, fin.id, res.id]
        );
        const nameRow = await pool.query('SELECT name FROM items WHERE id = $1', [itemId]);
        console.log(
            `\n=== Детализация (авто-ребаланс + снятие резерва), item_id=${itemId} ${nameRow.rows[0]?.name || ''} — до 80 строк ===`
        );
        console.table(det.rows);
    }

    const q6 = await pool.query(
        `
        SELECT COUNT(*)::int AS total_auto_reb_rows
        FROM inventory_movements m
        WHERE m.warehouse_id IN ($1, $2)
          AND ${AUTO_REB}
    `,
        [fin.id, res.id]
    );
    console.log('\n=== Итого строк с «Авто-ребаланс» на готовой+резерв ===', q6.rows[0]);

    const q7 = await pool.query(
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
        [res.id]
    );
    console.log('\n=== Число позиций заказов (pending/processing) с Δ(движения резерва − qty_reserved) > 0,01 ===', q7.rows[0]);

    await pool.end();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
