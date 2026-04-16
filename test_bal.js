const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'plittex_db',
  password: 'admin',
  port: 5432,
});
async function check() {
  const result = await pool.query("SELECT * FROM counterparties WHERE name ILIKE '%ТЕХНОСЕРВИС%'");
  if (result.rows.length === 0) return console.log("not found");
  const cpId = result.rows[0].id;

  const b1 = await pool.query("SELECT COALESCE(SUM(total_amount), 0) as s FROM client_orders WHERE counterparty_id = $1 AND status = 'completed'", [cpId]);
  const b2 = await pool.query("SELECT COALESCE(SUM(amount), 0) as s FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false", [cpId]);
  const b3 = await pool.query("SELECT COALESCE(SUM(amount), 0) as s FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase'", [cpId]);
  const b4 = await pool.query("SELECT COALESCE(SUM(amount), 0) as s FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false", [cpId]);
  const b5 = await pool.query("SELECT COALESCE(SUM(paid_amount), 0) as s FROM client_orders WHERE counterparty_id = $1 AND status IN ('pending', 'processing')", [cpId]);

  console.log('our_shipments:', b1.rows[0].s);
  console.log('our_payments:', b2.rows[0].s);
  console.log('their_shipments:', b3.rows[0].s);
  console.log('their_payments:', b4.rows[0].s);
  console.log('allocated:', b5.rows[0].s);
  process.exit();
}
check();
