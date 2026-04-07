const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query("DELETE FROM inventory_movements WHERE movement_type = 'shipment_reversal' AND linked_order_item_id IS NULL RETURNING id");
    console.log('Deleted orphaned overrides:', res.rows.length);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
  } finally {
    client.release();
    pool.end();
  }
}
run();
