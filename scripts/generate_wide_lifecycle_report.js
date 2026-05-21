'use strict';
/**
 * Широкий CSV: хронология по каждому товару с динамическими колонками событий.
 * UTF-8 BOM, разделитель ; — для русскоязычного Excel.
 *
 * «Начальный остаток 1 сорт» — агрегат положительных «вводных» на готовую+резерв
 * (initial, initial_balance, ревизия, инвентаризация 05.04, manual/PRODUCED по партии Начальные остатки).
 *
 * Движения готовая+резерв разложены без пересечений:
 * — Распалубка (1 сорт): finished_receipt (готовая) >0; reserve_receipt с transaction_id и quantity>0.
 * — Отгрузка: sales_shipment (quantity в БД отрицательная — в CSV со знаком).
 * — Возвраты: см. RETURN_TYPES (обычно положительное влияние на остаток; в CSV модуль для наглядности).
 * — Корректировки: все остальные строки по этим складам, кроме строк, уже вошедших в сумму «Начального остатка».
 *
 * Сверка: Начальный остаток + Σ(распалубка) + Σ(отгрузка) + Σ(корректировки) + Σ(возвраты_как_в_учёте)
 *   = Σ quantity по готовой+резерв (колонка «Текущий остаток 1 сорт»).
 *
 * «Начальный остаток 2 сорт» и остаток 2 сорт — склад markdown (отдельная логика, как ранее).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
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

/** Типы, выводимые в блок «Возвраты» (+ визуально модуль количества). */
const RETURN_TYPES = new Set([
    'customer_return',
    'shipment_reversal',
    'return_receipt',
    'sales_return',
]);

function fmtDateRu(ts) {
    if (!ts) return '';
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    try {
        return d.toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: 'Europe/Moscow',
        });
    } catch (_) {
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const yyyy = d.getUTCFullYear();
        return `${dd}.${mm}.${yyyy}`;
    }
}

function csvEscape(cell) {
    const s = cell == null ? '' : String(cell);
    if (/[;\r\n"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

/**
 * Число для CSV под Excel (RU): десятичная **запятая**.
 * Иначе строки вроде «20.06» Excel воспринимает как дату (20 июня), а не как 20,06 м³.
 */
function qtyToExcelCell(q, { signed = false } = {}) {
    if (q == null || q === '') return '';
    let n = Number(q);
    if (Number.isNaN(n)) return String(q);
    if (!signed && Object.is(n, -0)) n = 0;
    n = Math.round(n * 10000) / 10000;
    let s = String(n);
    if (s.includes('e') || s.includes('E')) {
        s = n.toFixed(12).replace(/\.?0+$/, '');
    }
    return s.replace('.', ',');
}

function qtyStr(q) {
    return qtyToExcelCell(q, { signed: false });
}

/** Знаковое количество (отгрузки, корректировки). */
function qtyStrSigned(q) {
    return qtyToExcelCell(q, { signed: true });
}

/**
 * Строка уже учтена только в агрегате «Начальный остаток» (не дублировать в корректировках).
 */
function matchesOpeningAggregateRow(r) {
    const qty = Number(r.quantity);
    if (!(qty > 0)) return false;
    const mt = String(r.movement_type || '');
    const desc = String(r.description || '');
    const bn = String(r.batch_number || '');

    if (mt === 'initial' || mt === 'initial_balance') return true;
    if (mt === 'ревизия') return true;
    if (mt === 'audit_adjustment' && desc.toLowerCase().includes('инвентаризация от 2026-04-05')) return true;
    if ((mt === 'manual_adjustment' || mt === 'PRODUCED') && /начальные\s+остатки/i.test(bn)) return true;
    return false;
}

(async () => {
    const whRes = await pool.query(
        `SELECT id, type FROM warehouses WHERE type IN ('drying','finished','reserve','markdown')`
    );
    const whByType = {};
    for (const r of whRes.rows) whByType[r.type] = r.id;

    const dryId = whByType.drying;
    const finId = whByType.finished;
    const resId = whByType.reserve;
    const mdId = whByType.markdown;
    if (!dryId || !finId || !resId || !mdId) {
        throw new Error('Не найдены склады drying / finished / reserve / markdown в warehouses');
    }

    const itemsRes = await pool.query(`
        SELECT m.item_id, COALESCE(MAX(i.name), '') AS product_name
        FROM inventory_movements m
        LEFT JOIN items i ON i.id = m.item_id
        GROUP BY m.item_id
        ORDER BY LOWER(TRIM(MAX(i.name))), m.item_id
    `);
    const items = itemsRes.rows;
    const itemIds = items.map((r) => r.item_id).filter((id) => Number.isFinite(Number(id)) && Number(id) > 0);

    if (itemIds.length === 0) {
        console.log('[generate_wide_lifecycle_report] нет строк в inventory_movements — файл не создан');
        await pool.end();
        return;
    }

    const openingRes = await pool.query(
        `
        SELECT m.item_id, SUM(m.quantity)::numeric AS opening_sum
        FROM inventory_movements m
        LEFT JOIN production_batches pb ON pb.id = m.batch_id
        WHERE m.item_id = ANY($1::int[])
          AND m.warehouse_id IN ($2, $3)
          AND COALESCE(m.quantity, 0) > 0
          AND (
            m.movement_type IN ('initial', 'initial_balance')
            OR m.movement_type = 'ревизия'
            OR (
              m.movement_type = 'audit_adjustment'
              AND m.description ILIKE '%Инвентаризация от 2026-04-05%'
            )
            OR (
              pb.batch_number IS NOT NULL
              AND pb.batch_number ILIKE '%Начальные остатки%'
              AND m.movement_type IN ('manual_adjustment', 'PRODUCED')
            )
          )
        GROUP BY m.item_id
    `,
        [itemIds, finId, resId]
    );
    const openingByItem = new Map(openingRes.rows.map((row) => [Number(row.item_id), Number(row.opening_sum)]));

    const openingG2Res = await pool.query(
        `
        SELECT m.item_id, SUM(m.quantity)::numeric AS opening_sum
        FROM inventory_movements m
        LEFT JOIN production_batches pb ON pb.id = m.batch_id
        WHERE m.item_id = ANY($1::int[])
          AND m.warehouse_id = $2
          AND COALESCE(m.quantity, 0) > 0
          AND (
            m.movement_type IN ('initial', 'initial_balance')
            OR m.movement_type = 'ревизия'
            OR (
              m.movement_type = 'audit_adjustment'
              AND m.description ILIKE '%Инвентаризация от 2026-04-05%'
            )
            OR (
              pb.batch_number IS NOT NULL
              AND pb.batch_number ILIKE '%Начальные остатки%'
              AND m.movement_type IN ('manual_adjustment', 'PRODUCED')
            )
          )
        GROUP BY m.item_id
    `,
        [itemIds, mdId]
    );
    const openingG2ByItem = new Map(openingG2Res.rows.map((row) => [Number(row.item_id), Number(row.opening_sum)]));

    const formingRes = await pool.query(
        `
        SELECT m.item_id, m.quantity, COALESCE(m.movement_date, m.created_at) AS ev_ts
        FROM inventory_movements m
        WHERE m.item_id = ANY($1::int[])
          AND m.movement_type = 'production_receipt'
          AND m.warehouse_id = $2
          AND m.quantity > 0
        ORDER BY m.item_id, ev_ts ASC, m.id ASC
    `,
        [itemIds, dryId]
    );

    const finResRes = await pool.query(
        `
        SELECT m.item_id,
               m.id,
               m.movement_type,
               m.quantity,
               m.transaction_id,
               m.warehouse_id,
               COALESCE(m.movement_date, m.created_at) AS ev_ts,
               m.description AS description,
               pb.batch_number
        FROM inventory_movements m
        LEFT JOIN production_batches pb ON pb.id = m.batch_id
        WHERE m.item_id = ANY($1::int[])
          AND m.warehouse_id IN ($2, $3)
        ORDER BY m.item_id, COALESCE(m.movement_date, m.created_at) ASC, m.id ASC
    `,
        [itemIds, finId, resId]
    );

    const byItem = new Map();
    for (const id of itemIds) {
        byItem.set(Number(id), {
            openingSum: openingByItem.get(Number(id)) || 0,
            openingSumG2: openingG2ByItem.get(Number(id)) || 0,
            forming: [],
            demold: [],
            ship: [],
            adjustments: [],
            returns: [],
            _reconQty: 0,
        });
    }

    for (const r of formingRes.rows) {
        const buck = byItem.get(Number(r.item_id));
        if (buck) buck.forming.push({ ts: r.ev_ts, qty: r.quantity });
    }

    for (const r of finResRes.rows) {
        const buck = byItem.get(Number(r.item_id));
        if (!buck) continue;

        const qty = Number(r.quantity) || 0;
        buck._reconQty += qty;

        const mt = String(r.movement_type || '');

        const isDemoldFinish = mt === 'finished_receipt' && Number(r.warehouse_id) === finId && qty > 0;
        const isDemoldReserve =
            mt === 'reserve_receipt' && r.transaction_id != null && qty > 0;

        if (isDemoldFinish || isDemoldReserve) {
            buck.demold.push({ ts: r.ev_ts, qty });
            continue;
        }
        if (mt === 'sales_shipment') {
            buck.ship.push({ ts: r.ev_ts, qty });
            continue;
        }
        if (RETURN_TYPES.has(mt)) {
            buck.returns.push({ ts: r.ev_ts, qty });
            continue;
        }
        if (matchesOpeningAggregateRow(r)) {
            continue;
        }
        buck.adjustments.push({ ts: r.ev_ts, qty });
    }

    const balRes = await pool.query(
        `
        SELECT m.item_id, COALESCE(SUM(m.quantity), 0)::numeric AS bal
        FROM inventory_movements m
        WHERE m.item_id = ANY($1::int[])
          AND m.warehouse_id IN ($2, $3)
        GROUP BY m.item_id
    `,
        [itemIds, finId, resId]
    );
    const balanceByItem = new Map(balRes.rows.map((row) => [Number(row.item_id), Number(row.bal)]));

    const balG2Res = await pool.query(
        `
        SELECT m.item_id, COALESCE(SUM(m.quantity), 0)::numeric AS bal
        FROM inventory_movements m
        WHERE m.item_id = ANY($1::int[])
          AND m.warehouse_id = $2
        GROUP BY m.item_id
    `,
        [itemIds, mdId]
    );
    const balanceG2ByItem = new Map(balG2Res.rows.map((row) => [Number(row.item_id), Number(row.bal)]));

    let maxF = 0;
    let maxD = 0;
    let maxS = 0;
    let maxA = 0;
    let maxR = 0;
    let reconMismatches = 0;

    const rowsBuilt = [];

    for (const row of items) {
        const id = Number(row.item_id);
        const buck =
            byItem.get(id) || {
                openingSum: 0,
                openingSumG2: 0,
                forming: [],
                demold: [],
                ship: [],
                adjustments: [],
                returns: [],
                _reconQty: 0,
            };
        maxF = Math.max(maxF, buck.forming.length);
        maxD = Math.max(maxD, buck.demold.length);
        maxS = Math.max(maxS, buck.ship.length);
        maxA = Math.max(maxA, buck.adjustments.length);
        maxR = Math.max(maxR, buck.returns.length);

        const bal = balanceByItem.get(id) ?? 0;
        const sumParts =
            buck.openingSum +
            buck.demold.reduce((s, e) => s + Number(e.qty), 0) +
            buck.ship.reduce((s, e) => s + Number(e.qty), 0) +
            buck.adjustments.reduce((s, e) => s + Number(e.qty), 0) +
            buck.returns.reduce((s, e) => s + Number(e.qty), 0);

        if (Math.abs(sumParts - bal) > 0.0001) reconMismatches += 1;

        rowsBuilt.push({
            product_name: row.product_name || '',
            opening_sum: buck.openingSum,
            opening_sum_g2: buck.openingSumG2,
            forming: buck.forming,
            demold: buck.demold,
            ship: buck.ship,
            adjustments: buck.adjustments,
            returns: buck.returns,
            balance_now: bal,
            balance_now_g2: balanceG2ByItem.get(id) ?? 0,
        });
    }

    const hdr = ['Название продукции', 'Начальный остаток 1 сорт (готовая+резерв)', 'Начальный остаток 2 сорт (уценка)'];
    for (let i = 1; i <= maxF; i++) {
        hdr.push(`Формовка ${i} (Дата)`, `Формовка ${i} (Кол-во)`);
    }
    for (let i = 1; i <= maxD; i++) {
        hdr.push(`Распалубка ${i} (Дата)`, `Распалубка ${i} (Кол-во)`);
    }
    for (let i = 1; i <= maxS; i++) {
        hdr.push(`Отгрузка ${i} (Дата)`, `Отгрузка ${i} (Кол-во)`);
    }
    for (let i = 1; i <= maxA; i++) {
        hdr.push(`Корректировка ${i} (Дата)`, `Корректировка ${i} (Кол-во)`);
    }
    for (let i = 1; i <= maxR; i++) {
        hdr.push(`Возврат ${i} (Дата)`, `Возврат ${i} (Кол-во)`);
    }
    hdr.push('Текущий остаток 1 сорт (готовая+резерв)', 'Текущий остаток 2 сорт (уценка)');

    const lines = [hdr.join(';')];
    for (const rb of rowsBuilt) {
        const cells = [
            csvEscape(rb.product_name),
            csvEscape(rb.opening_sum !== 0 ? qtyStr(rb.opening_sum) : ''),
            csvEscape(rb.opening_sum_g2 !== 0 ? qtyStr(rb.opening_sum_g2) : ''),
        ];

        for (let i = 0; i < maxF; i++) {
            const ev = rb.forming[i];
            cells.push(ev ? csvEscape(fmtDateRu(ev.ts)) : '', ev ? csvEscape(qtyStr(ev.qty)) : '');
        }
        for (let i = 0; i < maxD; i++) {
            const ev = rb.demold[i];
            cells.push(ev ? csvEscape(fmtDateRu(ev.ts)) : '', ev ? csvEscape(qtyStr(ev.qty)) : '');
        }
        for (let i = 0; i < maxS; i++) {
            const ev = rb.ship[i];
            cells.push(ev ? csvEscape(fmtDateRu(ev.ts)) : '', ev ? csvEscape(qtyStrSigned(ev.qty)) : '');
        }
        for (let i = 0; i < maxA; i++) {
            const ev = rb.adjustments[i];
            cells.push(ev ? csvEscape(fmtDateRu(ev.ts)) : '', ev ? csvEscape(qtyStrSigned(ev.qty)) : '');
        }
        for (let i = 0; i < maxR; i++) {
            const ev = rb.returns[i];
            const rq = ev ? Math.abs(Number(ev.qty) || 0) : 0;
            cells.push(ev ? csvEscape(fmtDateRu(ev.ts)) : '', ev && rq ? csvEscape(qtyStr(rq)) : '');
        }
        cells.push(csvEscape(qtyStr(rb.balance_now)), csvEscape(qtyStr(rb.balance_now_g2)));
        lines.push(cells.join(';'));
    }

    const outPath = path.join(__dirname, '..', 'product_lifecycle_wide.csv');
    fs.writeFileSync(outPath, `\uFEFF${lines.join('\r\n')}`, 'utf8');
    console.log(
        `[generate_wide_lifecycle_report] items=${items.length} формовки×2=${maxF * 2} распалубки×2=${maxD * 2} отгрузки×2=${maxS * 2} корректировки×2=${maxA * 2} возвраты×2=${maxR * 2}`
    );
    console.log(
        `[generate_wide_lifecycle_report] сверка 1 сорт: расхождений по строкам (должно быть 0): ${reconMismatches}`
    );
    console.log('[generate_wide_lifecycle_report] written:', outPath);

    await pool.end();
})().catch(async (err) => {
    console.error(err);
    try {
        await pool.end();
    } catch (_) {}
    process.exit(1);
});
