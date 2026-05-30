#!/usr/bin/env node
/**
 * Массовое удаление фантомных shipment_reversal от старого бага возвратов
 * (description «Возврат (авто-реверс): ВЗ-…»), до fix ab5c32a (2026-05-10).
 *
 * По умолчанию — только аудит (dry-run). Удаление: --execute
 *
 *   node scripts/cleanup_phantom_reversals.js
 *   node scripts/cleanup_phantom_reversals.js --execute
 */
require('dotenv').config();
const { Pool } = require('pg');

const PHANTOM_WHERE = `
    m.movement_type = 'shipment_reversal'
    AND m.description ILIKE '%авто-реверс%'
`;

const LIST_SQL = `
    SELECT
        m.id AS movement_id,
        m.quantity,
        m.movement_date,
        m.description,
        m.linked_order_item_id,
        m.order_id,
        co.id AS order_id_resolved,
        co.doc_number AS order_doc,
        co.status AS order_status,
        c.id AS counterparty_id,
        c.name AS client_name,
        i.id AS item_id,
        i.name AS item_name,
        coi.price,
        ROUND((ABS(m.quantity) * COALESCE(coi.price, 0))::numeric, 2) AS amount_rub,
        SUBSTRING(m.description FROM 'ВЗ-[0-9]+') AS vz_doc_hint
    FROM inventory_movements m
    LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
    LEFT JOIN client_orders co ON co.id = COALESCE(m.order_id, coi.order_id)
    LEFT JOIN counterparties c ON c.id = co.counterparty_id
    LEFT JOIN items i ON i.id = m.item_id
    WHERE ${PHANTOM_WHERE}
    ORDER BY m.id
`;

/** Фантомы не создавали transactions; проверяем ложные срабатывания по описанию. */
const RELATED_TX_SQL = `
    SELECT t.id, t.amount, t.category, t.description, t.linked_order_id
    FROM transactions t
    WHERE COALESCE(t.is_deleted, false) = false
      AND t.description ILIKE '%авто-реверс%'
`;

const RELATED_CR_SQL = `
    SELECT cr.id, cr.doc_number, cr.total_amount, cr.created_at, cr.counterparty_id
    FROM customer_returns cr
    WHERE cr.doc_number IN (
        SELECT DISTINCT SUBSTRING(m.description FROM 'ВЗ-[0-9]+')
        FROM inventory_movements m
        WHERE ${PHANTOM_WHERE}
          AND SUBSTRING(m.description FROM 'ВЗ-[0-9]+') IS NOT NULL
    )
`;

function parseArgs(argv) {
    const execute = argv.includes('--execute');
    const json = argv.includes('--json');
    return { execute, json };
}

function printTable(rows) {
    if (!rows.length) {
        console.log('(нет строк)');
        return;
    }
    console.table(rows.map((r) => ({
        movement_id: r.movement_id,
        order_doc: r.order_doc || '—',
        client: r.client_name || `cp#${r.counterparty_id || '?'}`,
        qty: r.quantity,
        amount_rub: r.amount_rub,
        vz: r.vz_doc_hint || '—',
        movement_date: r.movement_date
    })));
}

async function main() {
    const { execute, json } = parseArgs(process.argv.slice(2));

    const pool = new Pool({
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME
    });

    const client = await pool.connect();
    try {
        const listRes = await client.query(LIST_SQL);
        const phantoms = listRes.rows;

        const summary = {
            mode: execute ? 'execute' : 'dry-run',
            phantom_movements: phantoms.length,
            total_amount_rub: phantoms.reduce((s, r) => s + Number(r.amount_rub || 0), 0),
            distinct_clients: new Set(phantoms.map((r) => r.counterparty_id).filter(Boolean)).size,
            distinct_orders: new Set(phantoms.map((r) => r.order_id_resolved).filter(Boolean)).size
        };

        const relatedTx = await client.query(RELATED_TX_SQL);
        const relatedCr = await client.query(RELATED_CR_SQL);

        if (json) {
            console.log(JSON.stringify({
                summary,
                phantoms,
                related_transactions: relatedTx.rows,
                related_customer_returns: relatedCr.rows
            }, null, 2));
        } else {
            console.log('=== Фантомные авто-реверсы (shipment_reversal) ===\n');
            console.log(`Режим: ${summary.mode}`);
            console.log(`Найдено движений: ${summary.phantom_movements}`);
            console.log(`Сумма (оценка по price позиции): ${summary.total_amount_rub.toFixed(2)} ₽`);
            console.log(`Клиентов: ${summary.distinct_clients}, заказов: ${summary.distinct_orders}\n`);
            printTable(phantoms);

            if (relatedTx.rows.length) {
                console.log('\n⚠️ Связанные transactions с «авто-реверс» в описании (не удаляются автоматически):');
                console.table(relatedTx.rows);
            } else {
                console.log('\n✓ transactions с «авто-реверс» не найдены.');
            }

            if (relatedCr.rows.length) {
                console.log('\nℹ️ customer_returns с номерами из описаний фантомов (только отчёт, не удаляются):');
                console.table(relatedCr.rows);
            } else {
                console.log('\n✓ customer_returns по номерам ВЗ из фантомов не найдены.');
            }
        }

        if (!execute) {
            if (!json) {
                console.log('\nУдаление не выполнялось. Для DELETE: node scripts/cleanup_phantom_reversals.js --execute');
            }
            return;
        }

        if (phantoms.length === 0) {
            if (!json) console.log('\nНечего удалять.');
            return;
        }

        await client.query('BEGIN');
        const ids = phantoms.map((r) => Number(r.movement_id));
        const delRes = await client.query(
            `DELETE FROM inventory_movements
             WHERE id = ANY($1::int[])
               AND movement_type = 'shipment_reversal'
               AND description ILIKE '%авто-реверс%'`,
            [ids]
        );
        await client.query('COMMIT');

        const result = { deleted: delRes.rowCount, movement_ids: ids };
        if (json) {
            console.log(JSON.stringify({ ...summary, ...result }, null, 2));
        } else {
            console.log(`\n✅ Удалено движений: ${delRes.rowCount}`);
        }
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) { /* ignore */ }
        console.error('cleanup_phantom_reversals failed:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();
