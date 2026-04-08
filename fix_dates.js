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
    const res = await pool.query("UPDATE inventory_movements SET movement_date = '2026-03-01 00:00:00' WHERE description = 'Начальный остаток на 01.03.2026' RETURNING id");
    console.log('Updated rows:', res.rowCount);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
