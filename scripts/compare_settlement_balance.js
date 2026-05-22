#!/usr/bin/env node
/**
 * Phase 1: сверка legacy getCounterpartyBalance vs v_counterparty_settlement_facts.
 *
 * Usage:
 *   node scripts/compare_settlement_balance.js --id=123
 *   node scripts/compare_settlement_balance.js --name=АЗМК
 *
 * Перед запуском примените VIEW:
 *   psql ... -f migrations/20260521_counterparty_settlement_facts_view.sql
 */
require('dotenv').config();
const { Pool } = require('pg');
const { getCounterpartyBalance } = require('../utils/counterpartyBalance');

function dbConfigFromEnv() {
    return {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    };
}

function parseArgs(argv) {
    let id = null;
    let name = null;
    for (const arg of argv.slice(2)) {
        if (arg.startsWith('--id=')) id = Number(arg.slice(5));
        else if (arg.startsWith('--name=')) name = arg.slice(7).trim();
        else if (/^\d+$/.test(arg)) id = Number(arg);
    }
    return { id, name };
}

async function resolveCounterpartyId(pool, { id, name }) {
    if (id && Number.isFinite(id) && id > 0) {
        const r = await pool.query(
            'SELECT id, name, is_employee FROM counterparties WHERE id = $1 LIMIT 1',
            [id]
        );
        if (r.rows.length === 0) throw new Error(`Контрагент id=${id} не найден`);
        return r.rows[0];
    }
    if (name) {
        const r = await pool.query(
            `SELECT id, name, is_employee FROM counterparties
             WHERE name ILIKE $1 AND COALESCE(is_deleted, false) = false
             ORDER BY id ASC LIMIT 1`,
            [`%${name}%`]
        );
        if (r.rows.length === 0) throw new Error(`Контрагент по имени "${name}" не найден`);
        return r.rows[0];
    }
    throw new Error('Укажите --id=<число> или --name=Подстрока (например --name=АЗМК)');
}

async function loadFactsBalance(pool, cpId) {
    const sumRes = await pool.query(
        `SELECT COALESCE(SUM(balance_delta), 0)::numeric AS balance
         FROM v_counterparty_settlement_facts
         WHERE counterparty_id = $1`,
        [cpId]
    );
    const breakdownRes = await pool.query(
        `SELECT fact_type,
                COUNT(*)::int AS cnt,
                COALESCE(SUM(balance_delta), 0)::numeric AS delta_sum
         FROM v_counterparty_settlement_facts
         WHERE counterparty_id = $1
         GROUP BY fact_type
         ORDER BY fact_type`,
        [cpId]
    );
    return {
        balance: Number(sumRes.rows[0].balance || 0),
        breakdown: breakdownRes.rows
    };
}

async function main() {
    const args = parseArgs(process.argv);
    const pool = new Pool(dbConfigFromEnv());
    try {
        const cp = await resolveCounterpartyId(pool, args);
        const cpId = cp.id;

        const legacy = await getCounterpartyBalance(pool, cpId);
        const legacyBalance = Number(legacy.realBalance.toFixed(2));

        let facts;
        try {
            facts = await loadFactsBalance(pool, cpId);
        } catch (err) {
            if (String(err.message || '').includes('v_counterparty_settlement_facts')) {
                console.error('\nVIEW v_counterparty_settlement_facts не найдена.');
                console.error('Примените: migrations/20260521_counterparty_settlement_facts_view.sql\n');
            }
            throw err;
        }

        const factsBalance = Number(Number(facts.balance).toFixed(2));
        const diff = Number((factsBalance - legacyBalance).toFixed(2));

        console.log('--- Сверка сальдо контрагента (Phase 1) ---');
        console.log(`Контрагент: [${cpId}] ${cp.name} (is_employee=${cp.is_employee})`);
        console.log('');
        console.log(`Legacy (getCounterpartyBalance): ${legacyBalance.toFixed(2)} ₽`);
        console.log(`  our_shipments:  ${legacy.raw.our_shipments}`);
        console.log(`  our_payments:   ${legacy.raw.our_payments}`);
        console.log(`  their_shipments: ${legacy.raw.their_shipments}`);
        console.log(`  their_payments:  ${legacy.raw.their_payments}`);
        console.log('');
        console.log(`Facts VIEW (SUM balance_delta): ${factsBalance.toFixed(2)} ₽`);
        console.log('Разбивка по fact_type:');
        for (const row of facts.breakdown) {
            console.log(`  ${row.fact_type}: count=${row.cnt}, sum=${Number(row.delta_sum).toFixed(2)}`);
        }
        console.log('');
        console.log(`Разница (facts - legacy): ${diff.toFixed(2)} ₽`);
        if (Math.abs(diff) < 0.01) {
            console.log('OK: расхождение в пределах 1 копейки.');
        } else {
            console.log('ВНИМАНИЕ: есть расхождение. Возможные причины:');
            console.log('  - shipment_reversal в VIEW, но не в getCounterpartyBalance');
            console.log('  - категория «Возврат средств покупателю» (profile vs util)');
            console.log('  - иные транзакции вне фильтра util');
        }
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
