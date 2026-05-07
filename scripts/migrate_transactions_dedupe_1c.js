#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');

const INDEX_NAME = 'ux_transactions_1c_dedupe_key';
const SOURCE_TAG = '1c_import';

function dbConfigFromEnv() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  };
}

async function main() {
  const pool = new Pool(dbConfigFromEnv());
  const client = await pool.connect();

  try {
    console.log('== 1C dedupe migration start ==');
    console.log(`DB: ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT}`);

    await client.query('BEGIN');

    // 1) Normalize source tag for likely 1C imports.
    const sourceTagRes = await client.query(
      `
      UPDATE transactions
         SET reg_source_tag = $1
       WHERE (reg_source_tag IS NULL OR BTRIM(reg_source_tag) = '' OR reg_source_tag = 'legacy')
         AND description ~ '\\(№[^\\)]+\\)'
      `,
      [SOURCE_TAG]
    );
    console.log(`[normalize] source_tag updated: ${sourceTagRes.rowCount}`);

    // 2) Backfill doc number from description "(№...)" when missing.
    const docNoRes = await client.query(
      `
      UPDATE transactions
         SET reg_document_no = NULLIF(BTRIM(SUBSTRING(description FROM '\\(№([^\\)]+)\\)')), '')
       WHERE COALESCE(reg_source_tag, '') = $1
         AND (reg_document_no IS NULL OR BTRIM(reg_document_no) = '')
         AND description ~ '\\(№[^\\)]+\\)'
      `,
      [SOURCE_TAG]
    );
    console.log(`[normalize] reg_document_no backfilled: ${docNoRes.rowCount}`);

    // 3) Backfill document date from transaction_date when missing.
    const docDateRes = await client.query(
      `
      UPDATE transactions
         SET reg_document_date = transaction_date::date
       WHERE COALESCE(reg_source_tag, '') = $1
         AND reg_document_date IS NULL
         AND transaction_date IS NOT NULL
      `,
      [SOURCE_TAG]
    );
    console.log(`[normalize] reg_document_date backfilled: ${docDateRes.rowCount}`);

    // 4) Delete duplicates by stable key; keep the smallest id.
    const deleteDupRes = await client.query(
      `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY
              account_id,
              transaction_type,
              reg_document_date,
              ROUND(amount::numeric, 2),
              BTRIM(reg_document_no)
            ORDER BY id ASC
          ) AS rn
        FROM transactions
        WHERE COALESCE(is_deleted, false) = false
          AND COALESCE(reg_source_tag, '') = $1
          AND reg_document_no IS NOT NULL
          AND BTRIM(reg_document_no) <> ''
          AND reg_document_date IS NOT NULL
          AND account_id IS NOT NULL
      )
      DELETE FROM transactions t
      USING ranked r
      WHERE t.id = r.id
        AND r.rn > 1
      `,
      [SOURCE_TAG]
    );
    console.log(`[dedupe] duplicates deleted: ${deleteDupRes.rowCount}`);

    await client.query('COMMIT');
    console.log('[tx] committed');

    // 5) Create partial unique index outside transaction.
    const createIndexSql = `
      CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
      ON transactions (
        account_id,
        transaction_type,
        reg_document_date,
        ROUND(amount::numeric, 2),
        BTRIM(reg_document_no)
      )
      WHERE COALESCE(is_deleted, false) = false
        AND COALESCE(reg_source_tag, '') = '${SOURCE_TAG}'
        AND reg_document_no IS NOT NULL
        AND BTRIM(reg_document_no) <> ''
        AND reg_document_date IS NOT NULL
        AND account_id IS NOT NULL
    `;
    await client.query(createIndexSql);
    console.log(`[index] created/verified: ${INDEX_NAME}`);

    // 6) Final check: how many duplicate groups still remain.
    const postCheck = await client.query(
      `
      SELECT COUNT(*)::int AS duplicate_groups
      FROM (
        SELECT 1
        FROM transactions
        WHERE COALESCE(is_deleted, false) = false
          AND COALESCE(reg_source_tag, '') = $1
          AND reg_document_no IS NOT NULL
          AND BTRIM(reg_document_no) <> ''
          AND reg_document_date IS NOT NULL
          AND account_id IS NOT NULL
        GROUP BY
          account_id,
          transaction_type,
          reg_document_date,
          ROUND(amount::numeric, 2),
          BTRIM(reg_document_no)
        HAVING COUNT(*) > 1
      ) s
      `,
      [SOURCE_TAG]
    );
    console.log(`[check] remaining duplicate groups: ${postCheck.rows[0].duplicate_groups}`);
    console.log('== 1C dedupe migration done ==');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      console.error('[tx] rolled back');
    } catch (rollbackError) {
      console.error('[tx] rollback failed:', rollbackError.message);
    }
    console.error('[migration] failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
