'use strict';
/**
 * Выгрузка жизненного цикла партий в production_report.csv (UTF-8 BOM, разделитель ;).
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
});

function csvEscape(cell) {
    const s = cell == null ? '' : String(cell);
    if (/[;\r\n"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

(async () => {
    const { rows } = await pool.query(`
        SELECT
            pb.id,
            CASE
                WHEN pb.production_date IS NOT NULL THEN to_char(pb.production_date::date, 'DD.MM.YYYY')
                ELSE to_char(COALESCE(pb.created_at)::timestamptz AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY')
            END AS forma_date_ru,
            pb.batch_number,
            COALESCE(i.name, '') AS product_name,
            pb.planned_quantity::numeric AS plan_sqm,
            (
                SELECT MAX(COALESCE(m.movement_date, m.created_at))
                FROM inventory_movements m
                WHERE m.batch_id = pb.id
                  AND m.movement_type = 'wip_expense'
            ) AS last_wip_ts,
            pb.actual_good_qty::numeric AS fact_grade1_sqm,
            COALESCE((
                SELECT SUM(m.quantity)::numeric
                FROM inventory_movements m
                WHERE m.batch_id = pb.id
                  AND m.movement_type = 'markdown_receipt'
                  AND m.quantity > 0
            ), 0) AS fact_grade2_sqm,
            COALESCE((
                SELECT SUM(m.quantity)::numeric
                FROM inventory_movements m
                WHERE m.batch_id = pb.id
                  AND m.movement_type IN ('scrap_receipt', 'defect_receipt', 'tech_loss_receipt')
                  AND m.quantity > 0
            ), 0) AS scrap_util_sqm,
            CASE
                WHEN pb.planned_quantity > 0
                THEN ROUND((pb.actual_good_qty::numeric / pb.planned_quantity) * 100, 1)
                ELSE NULL
            END AS yield_grade1_pct
        FROM production_batches pb
        LEFT JOIN items i ON i.id = pb.product_id
        ORDER BY pb.production_date DESC NULLS LAST, pb.id DESC
    `);

    const headers = [
        'Дата формовки',
        'Номер партии',
        'Название продукции',
        'План формовки (кв.м.)',
        'Дата последней распалубки',
        'Факт 1 сорт (кв.м.)',
        'Факт 2 сорт (кв.м.)',
        'Брак / Утиль (кв.м.)',
        '% Выхода 1 сорта',
    ];

    function fmtDt(v) {
        if (!v) return '';
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return String(v);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
    }

    const lines = [headers.join(';')];
    for (const r of rows) {
        lines.push(
            [
                csvEscape(r.forma_date_ru),
                csvEscape(r.batch_number),
                csvEscape(r.product_name),
                csvEscape(String(r.plan_sqm ?? '')),
                csvEscape(fmtDt(r.last_wip_ts)),
                csvEscape(String(r.fact_grade1_sqm ?? '')),
                csvEscape(String(r.fact_grade2_sqm ?? '')),
                csvEscape(String(r.scrap_util_sqm ?? '')),
                csvEscape(r.yield_grade1_pct != null ? String(r.yield_grade1_pct) : ''),
            ].join(';')
        );
    }

    const bom = '\uFEFF';
    const outPath = path.join(__dirname, 'production_report.csv');
    fs.writeFileSync(outPath, bom + lines.join('\r\n'), 'utf8');
    console.log('[generate_batch_report] rows:', rows.length);
    console.log('[generate_batch_report] written:', outPath);

    await pool.end();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
