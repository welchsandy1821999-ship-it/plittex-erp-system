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

function normalizeHumanName(raw) {
  return String(raw || '')
    .replace(/^\s*Подотчет:\s*/i, '')
    .replace(/\[УВОЛЕН\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function hasColumn(client, tableName, columnName) {
  const q = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName]
  );
  return q.rows.length > 0;
}

async function step1BackfillAccounts(client, stats) {
  console.log('\n[STEP 1] Backfill accounts.employee_id / account_role');
  const q = await client.query(
    `
      SELECT id, name, type, employee_id
      FROM accounts
      WHERE employee_id IS NULL
        AND (type = 'imprest' OR name ILIKE 'Подотчет:%')
      ORDER BY id ASC
    `
  );

  stats.accounts.candidates = q.rows.length;
  for (const row of q.rows) {
    const normalizedName = normalizeHumanName(row.name);
    if (!normalizedName) {
      stats.accounts.skippedNoName += 1;
      continue;
    }

    const empMatch = await client.query(
      `
        SELECT id
        FROM employees
        WHERE TRIM(full_name) = $1
        ORDER BY id ASC
      `,
      [normalizedName]
    );

    const cpMatch = await client.query(
      `
        SELECT employee_id
        FROM counterparties
        WHERE is_employee = true
          AND employee_id IS NOT NULL
          AND TRIM(name) = $1
        ORDER BY id ASC
      `,
      [normalizedName]
    );

    const uniqueEmployeeIds = new Set();
    for (const e of empMatch.rows) uniqueEmployeeIds.add(Number(e.id));
    for (const c of cpMatch.rows) uniqueEmployeeIds.add(Number(c.employee_id));

    if (uniqueEmployeeIds.size !== 1) {
      stats.accounts.ambiguous += 1;
      continue;
    }

    const employeeId = Array.from(uniqueEmployeeIds)[0];
    await client.query(
      `
        UPDATE accounts
        SET employee_id = $1,
            account_role = 'imprest'
        WHERE id = $2
      `,
      [employeeId, row.id]
    );
    stats.accounts.updated += 1;
  }

  const roleFix = await client.query(
    `
      UPDATE accounts
      SET account_role = 'imprest'
      WHERE (type = 'imprest' OR name ILIKE 'Подотчет:%')
        AND (account_role IS NULL OR account_role <> 'imprest')
    `
  );
  stats.accounts.roleMarked += roleFix.rowCount;
  console.log(
    `[STEP 1] candidates=${stats.accounts.candidates}, updated=${stats.accounts.updated}, ambiguous=${stats.accounts.ambiguous}, skippedNoName=${stats.accounts.skippedNoName}, roleMarked=${stats.accounts.roleMarked}`
  );
}

async function step2BackfillTransactionsEmployee(client, stats) {
  console.log('\n[STEP 2] Backfill transactions.employee_id');

  const byAccount = await client.query(
    `
      UPDATE transactions t
      SET employee_id = a.employee_id
      FROM accounts a
      WHERE t.employee_id IS NULL
        AND t.account_id = a.id
        AND a.employee_id IS NOT NULL
    `
  );
  stats.transactions.byAccount = byAccount.rowCount;

  const byCounterparty = await client.query(
    `
      UPDATE transactions t
      SET employee_id = cp.employee_id
      FROM counterparties cp
      WHERE t.employee_id IS NULL
        AND t.counterparty_id = cp.id
        AND cp.is_employee = true
        AND cp.employee_id IS NOT NULL
    `
  );
  stats.transactions.byCounterparty = byCounterparty.rowCount;

  console.log(
    `[STEP 2] byAccount=${stats.transactions.byAccount}, byCounterparty=${stats.transactions.byCounterparty}`
  );
}

async function step3BridgeAdjustmentsAndTransactions(client, stats) {
  console.log('\n[STEP 3] Build salary_adjustments <-> transactions bridge');

  const hasAdjCreatedAt = await hasColumn(client, 'salary_adjustments', 'created_at');
  const hasAdjUpdatedAt = await hasColumn(client, 'salary_adjustments', 'updated_at');
  const hasTxCreatedAt = await hasColumn(client, 'transactions', 'created_at');

  let adjDateExpr = `to_date(sa.month_str || '-15', 'YYYY-MM-DD')`;
  if (hasAdjCreatedAt) adjDateExpr = `COALESCE(sa.created_at::date, ${adjDateExpr})`;
  if (hasAdjUpdatedAt) adjDateExpr = `COALESCE(sa.updated_at::date, ${adjDateExpr})`;
  const txDateExpr = hasTxCreatedAt
    ? `COALESCE(t.transaction_date::date, t.created_at::date)`
    : `t.transaction_date::date`;

  const adjRows = await client.query(
    `
      SELECT sa.id,
             sa.employee_id,
             ROUND(ABS(sa.amount::numeric), 2) AS abs_amount,
             ${adjDateExpr} AS anchor_date
      FROM salary_adjustments sa
      WHERE COALESCE(sa.is_deleted, false) = false
        AND sa.employee_id IS NOT NULL
        AND sa.linked_transaction_id IS NULL
      ORDER BY sa.id ASC
    `
  );

  stats.bridge.adjustmentsCandidates = adjRows.rows.length;
  const usedTxIds = new Set();

  for (const adj of adjRows.rows) {
    const txRows = await client.query(
      `
        SELECT t.id,
               ROUND(ABS(t.amount::numeric), 2) AS abs_amount,
               ${txDateExpr} AS tx_date
        FROM transactions t
        WHERE COALESCE(t.is_deleted, false) = false
          AND t.employee_id = $1
          AND t.salary_adjustment_id IS NULL
          AND ROUND(ABS(t.amount::numeric), 2) = $2
          AND ${txDateExpr} BETWEEN ($3::date - INTERVAL '1 day') AND ($3::date + INTERVAL '1 day')
        ORDER BY t.id ASC
      `,
      [adj.employee_id, adj.abs_amount, adj.anchor_date]
    );

    const candidates = txRows.rows.filter((r) => !usedTxIds.has(Number(r.id)));
    if (candidates.length !== 1) {
      if (candidates.length === 0) stats.bridge.noCandidate += 1;
      else stats.bridge.ambiguous += 1;
      continue;
    }

    const txId = Number(candidates[0].id);
    usedTxIds.add(txId);

    await client.query(
      `
        UPDATE salary_adjustments
        SET linked_transaction_id = $1
        WHERE id = $2
          AND linked_transaction_id IS NULL
      `,
      [txId, adj.id]
    );
    await client.query(
      `
        UPDATE transactions
        SET salary_adjustment_id = $1
        WHERE id = $2
          AND salary_adjustment_id IS NULL
      `,
      [adj.id, txId]
    );

    stats.bridge.linked += 1;
  }

  console.log(
    `[STEP 3] adjustmentsCandidates=${stats.bridge.adjustmentsCandidates}, linked=${stats.bridge.linked}, ambiguous=${stats.bridge.ambiguous}, noCandidate=${stats.bridge.noCandidate}`
  );
}

async function main() {
  const pool = new Pool(dbConfigFromEnv());
  const client = await pool.connect();
  const stats = {
    accounts: { candidates: 0, updated: 0, ambiguous: 0, skippedNoName: 0, roleMarked: 0 },
    transactions: { byAccount: 0, byCounterparty: 0 },
    bridge: { adjustmentsCandidates: 0, linked: 0, ambiguous: 0, noCandidate: 0 }
  };

  try {
    console.log('== Backfill history / ID-first bridge start ==');
    console.log(`DB: ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT}`);
    await client.query('BEGIN');

    await step1BackfillAccounts(client, stats);
    await step2BackfillTransactionsEmployee(client, stats);
    await step3BridgeAdjustmentsAndTransactions(client, stats);

    await client.query('COMMIT');
    console.log('\n[TX] committed');
    console.log('\n== Final stats ==');
    console.log(JSON.stringify(stats, null, 2));
    console.log('== Backfill history / ID-first bridge done ==');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      console.error('\n[TX] rolled back');
    } catch (rollbackError) {
      console.error('[TX] rollback failed:', rollbackError.message);
    }
    console.error('[BACKFILL] failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
