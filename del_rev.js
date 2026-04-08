const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'plittex_erp',
  password: 'Plittex_2026_SQL',
  port: 5432
});

async function run() {
  try {
    const res = await pool.query("DELETE FROM inventory_movements WHERE id = 729 RETURNING id");
    console.log('Deleted rows:', res.rowCount);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
