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
    await client.query('BEGIN');
    const q1 = await client.query(`
      UPDATE transactions t
      SET employee_id = c.employee_id
      FROM counterparties c
      WHERE t.counterparty_id = c.id
        AND t.employee_id IS DISTINCT FROM c.employee_id
    `);
    const q2 = await client.query(`
      UPDATE transactions t
      SET system_type = NULL
      WHERE t.employee_id IS NULL
        AND COALESCE(t.system_type, '') LIKE 'salary_%'
    `);
    await client.query('COMMIT');
    console.log(`SYNC_EMPLOYEE_ID_UPDATED=${q1.rowCount}`);
    console.log(`SALARY_SYSTEM_TYPE_CLEARED=${q2.rowCount}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
