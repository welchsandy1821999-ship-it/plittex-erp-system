#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');

function dbConfigFromEnv() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  };
}

function chooseDominant(counters, minRatio = 0.8) {
  const entries = Object.entries(counters)
    .map(([k, v]) => [Number(k), Number(v)])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  if (entries.length === 1) return { employeeId: entries[0][0], score: entries[0][1], ratio: 1 };
  const [topEmp, topScore] = entries[0];
  const secondScore = entries[1][1];
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (topScore === secondScore) return null;
  const ratio = total > 0 ? topScore / total : 0;
  if (ratio < minRatio) return null;
  return { employeeId: topEmp, score: topScore, ratio };
}

function normalizeForCompare(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[.\-_,;:()[\]"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveAccount(client, accountId) {
  // Источник 1: уже заполненные transactions.employee_id на этом счете
  const txEmployeeRows = await client.query(
    `
      SELECT employee_id, COUNT(*)::int AS cnt
      FROM transactions
      WHERE account_id = $1
        AND employee_id IS NOT NULL
        AND COALESCE(is_deleted, false) = false
      GROUP BY employee_id
    `,
    [accountId]
  );

  // Источник 2: employee-контрагент в проводках счета
  const txCounterpartyRows = await client.query(
    `
      SELECT cp.employee_id, COUNT(*)::int AS cnt
      FROM transactions t
      JOIN counterparties cp ON cp.id = t.counterparty_id
      WHERE t.account_id = $1
        AND cp.is_employee = true
        AND cp.employee_id IS NOT NULL
        AND COALESCE(t.is_deleted, false) = false
      GROUP BY cp.employee_id
    `,
    [accountId]
  );

  const counters = {};
  for (const r of txEmployeeRows.rows) {
    counters[r.employee_id] = (counters[r.employee_id] || 0) + Number(r.cnt) * 2; // employee_id в tx даем больший вес
  }
  for (const r of txCounterpartyRows.rows) {
    counters[r.employee_id] = (counters[r.employee_id] || 0) + Number(r.cnt);
  }

  return chooseDominant(counters, 0.8);
}

async function resolveByName(client, accountName) {
  const extracted = accountName.replace(/^\s*Подотчет:\s*/i, '').replace(/\[УВОЛЕН\]/gi, '').trim();
  const target = normalizeForCompare(extracted);
  if (!target) return null;

  const empRows = await client.query(
    `SELECT id, full_name, status FROM employees ORDER BY id ASC`
  );
  const cpRows = await client.query(
    `SELECT employee_id, name
     FROM counterparties
     WHERE is_employee = true
       AND employee_id IS NOT NULL
       AND COALESCE(is_deleted, false) = false
     ORDER BY id ASC`
  );

  const matches = new Set();
  for (const e of empRows.rows) {
    if (normalizeForCompare(e.full_name) === target) matches.add(Number(e.id));
  }
  for (const c of cpRows.rows) {
    if (normalizeForCompare(c.name) === target) matches.add(Number(c.employee_id));
  }
  if (matches.size === 1) return Array.from(matches)[0];

  // Fallback: surname + first initial (e.g. "Боднарчук Ростик" -> "Боднарчук Р. Р.")
  const parts = target.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    const surname = parts[0];
    const firstInitial = parts[1][0];
    const relaxed = new Set();
    for (const e of empRows.rows) {
      const eNorm = normalizeForCompare(e.full_name);
      const eParts = eNorm.split(' ').filter(Boolean);
      if (eParts.length < 2) continue;
      if (eParts[0] !== surname) continue;
      if (eParts[1][0] === firstInitial) relaxed.add(Number(e.id));
    }
    for (const c of cpRows.rows) {
      const cNorm = normalizeForCompare(c.name);
      const cParts = cNorm.split(' ').filter(Boolean);
      if (cParts.length < 2) continue;
      if (cParts[0] !== surname) continue;
      if (cParts[1][0] === firstInitial) relaxed.add(Number(c.employee_id));
    }
    if (relaxed.size === 1) return Array.from(relaxed)[0];
  }
  return null;
}

async function main() {
  const pool = new Pool(dbConfigFromEnv());
  const client = await pool.connect();

  const stats = {
    candidates: 0,
    rescued: 0,
    unresolved: 0,
    unresolvedIds: []
  };

  try {
    console.log('== Backfill v2 (ambiguous imprest accounts) ==');
    console.log(`DB: ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT}`);
    await client.query('BEGIN');

    const accounts = await client.query(
      `
        SELECT id, name, type
        FROM accounts
        WHERE employee_id IS NULL
          AND (type = 'imprest' OR name ILIKE 'Подотчет:%')
        ORDER BY id ASC
      `
    );

    stats.candidates = accounts.rows.length;
    console.log(`[v2] ambiguous candidates: ${stats.candidates}`);

    for (const acc of accounts.rows) {
      const pick = await resolveAccount(client, acc.id);
      let resolvedEmployeeId = null;
      if (pick) {
        resolvedEmployeeId = pick.employeeId;
      } else {
        resolvedEmployeeId = await resolveByName(client, acc.name);
      }

      if (!resolvedEmployeeId) {
        stats.unresolved += 1;
        stats.unresolvedIds.push(acc.id);
        continue;
      }

      await client.query(
        `
          UPDATE accounts
          SET employee_id = $1,
              account_role = 'imprest'
          WHERE id = $2
            AND employee_id IS NULL
        `,
        [resolvedEmployeeId, acc.id]
      );
      stats.rescued += 1;
      if (pick) {
        console.log(`[v2] account #${acc.id} -> employee #${resolvedEmployeeId} (movement ratio=${pick.ratio.toFixed(2)}, score=${pick.score})`);
      } else {
        console.log(`[v2] account #${acc.id} -> employee #${resolvedEmployeeId} (name exact-normalized match)`);
      }
    }

    await client.query('COMMIT');
    console.log('[v2] committed');
    console.log(`[v2] rescued=${stats.rescued}, unresolved=${stats.unresolved}`);
    if (stats.unresolvedIds.length) {
      console.log(`[v2] unresolved account ids: ${stats.unresolvedIds.join(', ')}`);
    }
  } catch (e) {
    try {
      await client.query('ROLLBACK');
      console.error('[v2] rolled back');
    } catch (rb) {
      console.error('[v2] rollback failed:', rb.message);
    }
    console.error('[v2] failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
