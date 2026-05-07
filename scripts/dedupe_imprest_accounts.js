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

async function pickCanonicalAccount(client, accountIds) {
  const q = await client.query(
    `
      SELECT a.id,
             COALESCE(tx.cnt, 0) AS tx_count
      FROM accounts a
      LEFT JOIN (
          SELECT account_id, COUNT(*)::int AS cnt
          FROM transactions
          WHERE account_id = ANY($1::int[])
          GROUP BY account_id
      ) tx ON tx.account_id = a.id
      WHERE a.id = ANY($1::int[])
      ORDER BY tx_count DESC, a.id ASC
    `,
    [accountIds]
  );
  if (!q.rows.length) return null;
  return Number(q.rows[0].id);
}

async function recalcAccountBalance(client, accountId) {
  await client.query(
    `
      UPDATE accounts a
      SET balance = ROUND(
        COALESCE((
          SELECT SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END) -
                 SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END)
          FROM transactions t
          WHERE t.account_id = a.id
            AND COALESCE(t.is_deleted, false) = false
        ), 0),
        2
      )
      WHERE a.id = $1
    `,
    [accountId]
  );
}

async function main() {
  const pool = new Pool(dbConfigFromEnv());
  const client = await pool.connect();
  const stats = {
    groupsFound: 0,
    duplicateAccountsArchived: 0,
    transactionsRepointed: 0,
    groups: []
  };

  try {
    console.log('== Dedupe imprest accounts start ==');
    console.log(`DB: ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT}`);
    await client.query('BEGIN');

    const dupGroups = await client.query(
      `
        SELECT employee_id, ARRAY_AGG(id ORDER BY id ASC) AS account_ids, COUNT(*)::int AS cnt
        FROM accounts
        WHERE account_role = 'imprest'
          AND employee_id IS NOT NULL
        GROUP BY employee_id
        HAVING COUNT(*) > 1
        ORDER BY employee_id ASC
      `
    );

    stats.groupsFound = dupGroups.rows.length;
    console.log(`[dedupe] duplicate groups: ${stats.groupsFound}`);

    for (const g of dupGroups.rows) {
      const employeeId = Number(g.employee_id);
      const ids = g.account_ids.map(Number);
      const canonicalId = await pickCanonicalAccount(client, ids);
      if (!canonicalId) continue;
      const duplicates = ids.filter((id) => id !== canonicalId);

      let movedForGroup = 0;
      for (const dupId of duplicates) {
        const moved = await client.query(
          `UPDATE transactions SET account_id = $1 WHERE account_id = $2`,
          [canonicalId, dupId]
        );
        movedForGroup += moved.rowCount;
        stats.transactionsRepointed += moved.rowCount;

        await client.query(
          `
            UPDATE accounts
            SET account_role = 'archived_duplicate',
                balance = 0,
                name = CASE
                    WHEN name ILIKE '%[DUP%' THEN name
                    ELSE name || ' [DUP->' || $1::text || ']'
                END
            WHERE id = $2
          `,
          [canonicalId, dupId]
        );
        stats.duplicateAccountsArchived += 1;
      }

      await recalcAccountBalance(client, canonicalId);
      stats.groups.push({
        employeeId,
        canonicalId,
        archivedIds: duplicates,
        movedTransactions: movedForGroup
      });
      console.log(
        `[dedupe] employee #${employeeId}: canonical=${canonicalId}, archived=[${duplicates.join(', ')}], movedTx=${movedForGroup}`
      );
    }

    await client.query('COMMIT');
    console.log('[dedupe] committed');
    console.log(
      `[dedupe] groups=${stats.groupsFound}, archived=${stats.duplicateAccountsArchived}, repointedTx=${stats.transactionsRepointed}`
    );
  } catch (e) {
    try {
      await client.query('ROLLBACK');
      console.error('[dedupe] rolled back');
    } catch (rb) {
      console.error('[dedupe] rollback failed:', rb.message);
    }
    console.error('[dedupe] failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
