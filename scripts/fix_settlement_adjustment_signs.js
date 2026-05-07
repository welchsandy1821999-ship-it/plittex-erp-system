#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME
  });
  const client = await pool.connect();
  try {
    const q = await client.query(`
      UPDATE salary_adjustments
      SET amount = amount * -1
      WHERE linked_transaction_id IS NOT NULL
        AND source_module = 'finance'
    `);
    console.log(`SALARY_ADJUSTMENTS_INVERTED=${q.rowCount}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
